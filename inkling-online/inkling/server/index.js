'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { LANGUAGES, loadWords, availableLanguages } = require('./words');
const U = require('./util');

// ------------------------------------------------------------------ config
const FAST = process.env.INK_FAST === '1'; // used by the automated test
const CHOOSE_MS = FAST ? 1500 : 15000;     // time the drawer has to pick a word
const TURN_END_MS = FAST ? 300 : 6000;     // "the word was ..." pause
const GAME_END_MS = FAST ? 300 : 12000;    // podium screen
const AUTO_START_MS = FAST ? 200 : 5000;   // public rooms start by themselves
const GRACE_MS = 30000;                    // reconnect window after a disconnect
const DRAW_TIMES = [15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180, 210, 240];
const MODES = ['normal', 'hidden', 'combination'];
const MAX_STROKES = 1500;
const MAX_POINTS = 8000;
const REPORT_REASONS = ['inappropriate', 'spam', 'cheating'];
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch (_) { /* read-only fs: reports just won't be saved */ }

const rooms = new Map();
let io;

// ------------------------------------------------------------------ helpers
const defaultSettings = (language = 'en') => ({
  maxPlayers: 8, language, drawTime: 80, rounds: 3, mode: 'normal',
  wordCount: 3, hints: 2, customWords: [], customWordsText: '', customOnly: false
});

function makeCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c;
  do { c = Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function ipHash(socket) {
  let raw = socket.handshake.address || '';
  if (process.env.TRUST_PROXY === '1') {
    const xf = socket.handshake.headers['x-forwarded-for'];
    if (xf) raw = String(xf).split(',')[0].trim();
  }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function allow(socket, key, max, windowMs) {
  const now = Date.now();
  const store = socket.data.rl || (socket.data.rl = {});
  const arr = store[key] || (store[key] = []);
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}

const emitAll = (room, ev, data) => io.to(room.code).emit(ev, data);
const emitPlayer = (p, ev, data) => { if (p && p.connected) io.to(p.socketId).emit(ev, data); };
const connected = (room) => room.players.filter(p => p.connected);
const getPlayer = (room, id) => room.players.find(p => p.id === id);
const drawerOf = (room) => getPlayer(room, room.drawerId);

function publicPlayer(room, p) {
  return {
    id: p.id, name: p.name, avatar: p.avatar, score: p.score, hasGuessed: p.hasGuessed,
    connected: p.connected, isOwner: room.ownerId === p.id, isDrawer: room.drawerId === p.id &&
      (room.state === 'choosing' || room.state === 'drawing')
  };
}
const broadcastPlayers = (room) =>
  emitAll(room, 'players', { players: room.players.map(p => publicPlayer(room, p)), ownerId: room.ownerId });

function settingsView(room) {
  const { customWords, ...rest } = room.settings;
  return rest;
}

function snapshot(room, p) {
  const isDrawer = room.drawerId === p.id;
  const live = ['choosing', 'drawing', 'turnEnd'].includes(room.state);
  return {
    selfId: p.id, token: p.token, code: room.code, isPrivate: room.isPrivate, ownerId: room.ownerId,
    settings: settingsView(room), players: room.players.map(x => publicPlayer(room, x)),
    state: room.state, round: room.round, rounds: room.settings.rounds, drawerId: room.drawerId,
    endsAt: room.endsAt, serverNow: Date.now(), autoStartAt: room.autoStartAt || null,
    mask: room.state === 'drawing' && !isDrawer ? room.mask : null,
    hidden: room.settings.mode === 'hidden',
    word: room.state === 'drawing' && isDrawer ? room.word : null,
    choices: room.state === 'choosing' && isDrawer ? room.choices : null,
    revealWord: room.state === 'turnEnd' ? room.word : null,
    strokes: live ? room.strokes : []
  };
}

function sendChat(room, msg, filter) {
  for (const p of room.players) if (!filter || filter(p)) emitPlayer(p, 'chat:message', msg);
}
const system = (room, text, kind = 'system') => sendChat(room, { type: kind, text });

function clearTimers(room) {
  clearTimeout(room.chooseTimer); clearTimeout(room.drawTimer); clearTimeout(room.nextTimer);
  (room.hintTimers || []).forEach(clearTimeout);
  room.hintTimers = [];
}

// ------------------------------------------------------------------ settings
function applySettings(room, inp) {
  if (!inp || typeof inp !== 'object') return;
  const s = room.settings;
  const pick = (v, list) => { v = Number(v); return list.includes(v) ? v : null; };
  let v;
  if ((v = pick(inp.maxPlayers, range(2, 20))) !== null && v >= room.players.length) s.maxPlayers = v;
  if (typeof inp.language === 'string' && LANGUAGES[inp.language]) s.language = inp.language;
  if ((v = pick(inp.drawTime, DRAW_TIMES)) !== null) s.drawTime = v;
  if ((v = pick(inp.rounds, range(2, 10))) !== null) s.rounds = v;
  if (MODES.includes(inp.mode)) s.mode = inp.mode;
  if ((v = pick(inp.wordCount, range(1, 5))) !== null) s.wordCount = v;
  if ((v = pick(inp.hints, range(0, 5))) !== null) s.hints = v;
  if (typeof inp.customWordsText === 'string') {
    s.customWordsText = inp.customWordsText.slice(0, 20000);
    s.customWords = [...new Set(s.customWordsText.split(/[,\n]/).map(U.clean)
      .filter(w => w.length >= 1 && w.length <= 40))].slice(0, 2000);
  }
  if (typeof inp.customOnly === 'boolean') s.customOnly = inp.customOnly;
}

// ------------------------------------------------------------------ words
function pickWords(room) {
  const s = room.settings;
  const base = loadWords(s.language);
  const custom = s.customWords;
  let pool = s.customOnly && custom.length ? custom : base.concat(custom);
  const n = s.wordCount;
  if (s.mode === 'combination') {
    const out = [];
    for (let i = 0; i < n; i++) {
      const [a, b] = U.shuffle(pool).slice(0, 2);
      out.push(b ? `${a} ${b}` : a);
    }
    return out;
  }
  let fresh = pool.filter(w => !room.usedWords.has(w));
  if (fresh.length < n) { room.usedWords.clear(); fresh = pool; }
  return U.shuffle(fresh).slice(0, n);
}

const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);
function buildMask(word) {
  return Array.from(word).map(ch => (isLetter(ch) ? '_' : ch));
}

// ------------------------------------------------------------------ game flow
function startGame(room) {
  if (connected(room).length < 2 || room.state !== 'lobby') return;
  clearTimers(room);
  clearTimeout(room.autoTimer); room.autoTimer = null; room.autoStartAt = null;
  room.players.forEach(p => { p.score = 0; p.hasGuessed = false; });
  room.round = 0; room.queue = []; room.usedWords = new Set(); room.drawerId = null;
  emitAll(room, 'game:start', {});
  system(room, 'The game has started. Good luck!');
  nextTurn(room);
}

function nextTurn(room) {
  clearTimers(room);
  if (connected(room).length < 2) return resetToLobby(room);
  let drawer = null;
  while (!drawer) {
    if (!room.queue.length) {
      room.round++;
      if (room.round > room.settings.rounds) { room.round = room.settings.rounds; return endGame(room); }
      room.queue = room.players.filter(p => p.connected).map(p => p.id);
    }
    const p = getPlayer(room, room.queue.shift());
    if (p && p.connected) drawer = p;
  }
  room.drawerId = drawer.id;
  room.state = 'choosing';
  room.word = null; room.mask = null; room.strokes = []; room.currentStroke = null;
  room.guessCount = 0;
  room.players.forEach(p => { p.hasGuessed = false; p.turnPoints = 0; });
  room.choices = pickWords(room);
  room.endsAt = Date.now() + CHOOSE_MS;
  broadcastPhase(room);
  broadcastPlayers(room);
  if (room.choices.length === 1) return beginDrawing(room, room.choices[0]);
  emitPlayer(drawer, 'game:choices', { choices: room.choices });
  room.chooseTimer = setTimeout(() => {
    if (room.state === 'choosing') beginDrawing(room, room.choices[Math.floor(Math.random() * room.choices.length)]);
  }, CHOOSE_MS);
}

function broadcastPhase(room) {
  emitAll(room, 'game:phase', {
    state: room.state, round: room.round, rounds: room.settings.rounds,
    drawerId: room.drawerId, endsAt: room.endsAt, serverNow: Date.now(),
    hidden: room.settings.mode === 'hidden'
  });
}

function beginDrawing(room, word) {
  clearTimeout(room.chooseTimer);
  const s = room.settings;
  room.word = word;
  room.usedWords.add(word);
  room.state = 'drawing';
  room.endsAt = Date.now() + s.drawTime * 1000;
  room.mask = s.mode === 'hidden' ? null : buildMask(word);
  broadcastPhase(room);
  const drawer = drawerOf(room);
  for (const p of room.players) {
    if (p.id === room.drawerId) emitPlayer(p, 'game:word', { word });
    else emitPlayer(p, 'game:mask', { mask: room.mask, hidden: s.mode === 'hidden' });
  }
  system(room, `${drawer ? drawer.name : 'Someone'} is drawing now!`);
  // hints
  const idx = room.mask ? room.mask.map((c, i) => (c === '_' ? i : -1)).filter(i => i >= 0) : [];
  const maxHints = idx.length <= 2 ? 0 : Math.min(s.hints, Math.floor(idx.length / 2));
  const order = U.shuffle(idx);
  for (let i = 1; i <= maxHints; i++) {
    room.hintTimers.push(setTimeout(() => {
      if (room.state !== 'drawing') return;
      const k = order[i - 1];
      room.mask[k] = Array.from(room.word)[k];
      for (const p of room.players) if (p.id !== room.drawerId) emitPlayer(p, 'game:mask', { mask: room.mask, hidden: false, hint: true });
    }, (s.drawTime * 1000 * i) / (maxHints + 1)));
  }
  room.drawTimer = setTimeout(() => endTurn(room, 'time'), s.drawTime * 1000);
}

const nonDrawers = (room) => room.players.filter(p => p.id !== room.drawerId);
const allGuessed = (room) => {
  const g = nonDrawers(room).filter(p => p.connected);
  return g.length > 0 && g.every(p => p.hasGuessed);
};

function endTurn(room, reason) {
  if (room.state !== 'drawing') return;
  clearTimers(room);
  const others = nonDrawers(room);
  const sum = others.reduce((a, p) => a + p.turnPoints, 0);
  const drawer = drawerOf(room);
  if (drawer && others.length) drawer.turnPoints = Math.round(sum / others.length), drawer.score += drawer.turnPoints;
  room.state = 'turnEnd';
  room.endsAt = Date.now() + TURN_END_MS;
  emitAll(room, 'game:turnEnd', {
    word: room.word, reason, endsAt: room.endsAt, serverNow: Date.now(),
    scores: room.players.map(p => ({ id: p.id, delta: p.turnPoints, score: p.score }))
  });
  broadcastPlayers(room);
  system(room, `The word was "${room.word}".`, 'reveal');
  room.nextTimer = setTimeout(() => nextTurn(room), TURN_END_MS);
}

function endGame(room) {
  clearTimers(room);
  room.state = 'gameEnd';
  room.drawerId = null;
  const ranking = room.players.slice().sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
  emitAll(room, 'game:end', { ranking, endsAt: Date.now() + GAME_END_MS, serverNow: Date.now() });
  broadcastPhase(room);
  room.nextTimer = setTimeout(() => resetToLobby(room), GAME_END_MS);
}

function resetToLobby(room) {
  clearTimers(room);
  room.state = 'lobby'; room.drawerId = null; room.word = null; room.mask = null;
  room.strokes = []; room.currentStroke = null; room.round = 0; room.queue = [];
  room.players.forEach(p => { p.hasGuessed = false; p.turnPoints = 0; });
  room.endsAt = null;
  emitAll(room, 'room:lobby', snapshotLite(room));
  broadcastPlayers(room);
  maybeAutoStart(room);
}
const snapshotLite = (room) => ({ settings: settingsView(room), ownerId: room.ownerId, autoStartAt: room.autoStartAt || null, serverNow: Date.now() });

function maybeAutoStart(room) {
  if (room.isPrivate || room.state !== 'lobby' || room.autoTimer) return;
  if (connected(room).length < 2) return;
  room.autoStartAt = Date.now() + AUTO_START_MS;
  emitAll(room, 'lobby:countdown', { autoStartAt: room.autoStartAt, serverNow: Date.now() });
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null; room.autoStartAt = null;
    startGame(room);
  }, AUTO_START_MS);
}

// ------------------------------------------------------------------ rooms & players
function createRoom(isPrivate, language) {
  const room = {
    code: makeCode(), isPrivate, settings: defaultSettings(language), players: [], ownerId: null,
    bans: new Set(), state: 'lobby', round: 0, queue: [], drawerId: null, word: null, mask: null,
    choices: [], strokes: [], currentStroke: null, strokeSeq: 0, usedWords: new Set(), guessCount: 0,
    endsAt: null, hintTimers: [], chat: [], autoTimer: null, autoStartAt: null
  };
  rooms.set(room.code, room);
  return room;
}

function sanitizeAvatar(a) {
  const n = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 && v < max ? v : 0; };
  a = a || {};
  return { color: n(a.color, 12), eyes: n(a.eyes, 6), mouth: n(a.mouth, 6) };
}

function joinRoom(socket, room, data) {
  const ip = ipHash(socket);
  if (room.bans.has(ip)) return socket.emit('join:error', { code: 'BANNED' });
  if (room.players.length >= room.settings.maxPlayers) return socket.emit('join:error', { code: 'ROOM_FULL' });
  leaveCurrent(socket);
  const p = {
    id: crypto.randomUUID(), token: crypto.randomUUID(), socketId: socket.id,
    name: U.sanitizeName(data && data.name), avatar: sanitizeAvatar(data && data.avatar),
    score: 0, hasGuessed: false, connected: true, ip, kickVotes: new Set(), graceTimer: null, turnPoints: 0
  };
  room.players.push(p);
  if (room.isPrivate && !room.ownerId) room.ownerId = p.id;
  socket.data.roomCode = room.code; socket.data.playerId = p.id;
  socket.join(room.code);
  socket.emit('room:joined', snapshot(room, p));
  broadcastPlayers(room);
  system(room, `${p.name} joined the room.`);
  maybeAutoStart(room);
}

function ctxOf(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return {};
  return { room, player: getPlayer(room, socket.data.playerId) };
}

function leaveCurrent(socket) {
  const { room, player } = ctxOf(socket);
  if (room && player) removePlayer(room, player, 'left');
  socket.data.roomCode = null; socket.data.playerId = null;
}

function removePlayer(room, p, why) {
  clearTimeout(p.graceTimer);
  const wasDrawer = room.drawerId === p.id;
  room.players = room.players.filter(x => x.id !== p.id);
  const sock = io.sockets.sockets.get(p.socketId);
  if (sock) { sock.leave(room.code); if (sock.data.playerId === p.id) { sock.data.roomCode = null; sock.data.playerId = null; } }
  if (!room.players.length) return destroyRoom(room);
  if (room.ownerId === p.id) {
    const next = room.players.find(x => x.connected) || room.players[0];
    room.ownerId = room.isPrivate ? next.id : null;
  }
  emitAll(room, 'player:left', { id: p.id });
  broadcastPlayers(room);
  if (why !== 'silent') system(room, `${p.name} ${why === 'left' ? 'left the room' : why}.`);
  if (room.state === 'lobby') { if (connected(room).length < 2) { clearTimeout(room.autoTimer); room.autoTimer = null; room.autoStartAt = null; } return; }
  if (connected(room).length < 2) return resetToLobby(room);
  if (wasDrawer && room.state === 'drawing') return endTurn(room, 'drawerLeft');
  if (wasDrawer && room.state === 'choosing') return nextTurn(room);
  if (room.state === 'drawing' && allGuessed(room)) endTurn(room, 'allGuessed');
}

function destroyRoom(room) {
  clearTimers(room);
  clearTimeout(room.autoTimer);
  rooms.delete(room.code);
}

function findPublicRoom(language, ip) {
  return [...rooms.values()]
    .filter(r => !r.isPrivate && r.settings.language === language && r.players.length < r.settings.maxPlayers && !r.bans.has(ip))
    .sort((a, b) => b.players.length - a.players.length)[0];
}

// ------------------------------------------------------------------ guess / chat
function handleChat(socket, raw) {
  const { room, player: p } = ctxOf(socket);
  if (!room || !p) return;
  if (!allow(socket, 'chat', 5, 3000)) return socket.emit('chat:message', { type: 'system', text: 'Slow down a little.' });
  const text = U.sanitizeChat(raw);
  if (!text) return;
  const isDrawer = room.drawerId === p.id;
  const lang = room.settings.language;
  const entry = { t: Date.now(), id: p.id, name: p.name, text };
  room.chat.push(entry); if (room.chat.length > 30) room.chat.shift();

  if (room.state === 'drawing' && !isDrawer && !p.hasGuessed) {
    const guess = U.normalize(text, lang), word = U.normalize(room.word, lang);
    if (guess && guess === word) {
      const ratio = Math.max(0, room.endsAt - Date.now()) / (room.settings.drawTime * 1000);
      const pts = Math.max(50, Math.round(100 + 400 * ratio) - 25 * room.guessCount);
      room.guessCount++;
      p.hasGuessed = true; p.turnPoints = pts; p.score += pts;
      sendChat(room, { type: 'correct', fromId: p.id, text: `${p.name} guessed the word!` });
      emitPlayer(p, 'game:word', { word: room.word, guesser: true });
      broadcastPlayers(room);
      if (allGuessed(room)) endTurn(room, 'allGuessed');
      return;
    }
    if (guess.length > 3 && U.levenshtein(guess, word) === 1) {
      emitPlayer(p, 'chat:message', { type: 'close', text: `"${text}" is close!` });
    }
    return sendChat(room, { type: 'normal', fromId: p.id, name: p.name, text });
  }
  // players who already know the word (and the drawer) talk in a private channel
  if (room.state === 'drawing' && (isDrawer || p.hasGuessed)) {
    return sendChat(room, { type: 'guessed', fromId: p.id, name: p.name, text },
      x => x.id === room.drawerId || x.hasGuessed);
  }
  sendChat(room, { type: 'normal', fromId: p.id, name: p.name, text });
}

// ------------------------------------------------------------------ moderation
function kickPlayer(room, target, ban, label) {
  if (ban) room.bans.add(target.ip);
  emitPlayer(target, 'kicked', { ban: !!ban });
  system(room, `${target.name} was ${ban ? 'banned' : 'kicked'}${label ? ' (' + label + ')' : ''}.`);
  removePlayer(room, target, 'silent');
}

function validColor(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '#000000'; }
const num01 = (v) => { v = Number(v); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const cleanPoint = (pt) => [Math.round(num01(pt[0]) * 10000) / 10000, Math.round(num01(pt[1]) * 10000) / 10000,
  Math.round(Math.min(3, Math.max(0.1, Number(pt[2]) || 1)) * 100) / 100];

// ------------------------------------------------------------------ sockets
function registerSocket(socket) {
  const guard = (fn) => (...args) => { try { fn(...args); } catch (e) { console.error('handler error:', e); } };

  socket.on('play', guard((data) => {
    if (!allow(socket, 'join', 6, 10000)) return;
    const lang = data && LANGUAGES[data.language] ? data.language : 'en';
    const room = findPublicRoom(lang, ipHash(socket)) || createRoom(false, lang);
    joinRoom(socket, room, data);
  }));

  socket.on('room:create', guard((data) => {
    if (!allow(socket, 'create', 5, 60000)) return socket.emit('join:error', { code: 'RATE_LIMIT' });
    const lang = data && LANGUAGES[data.language] ? data.language : 'en';
    joinRoom(socket, createRoom(true, lang), data);
  }));

  socket.on('room:join', guard((data) => {
    if (!allow(socket, 'join', 6, 10000)) return;
    const room = rooms.get(String((data && data.code) || '').toLowerCase());
    if (!room) return socket.emit('join:error', { code: 'ROOM_NOT_FOUND' });
    joinRoom(socket, room, data);
  }));

  socket.on('rejoin', guard((data) => {
    const room = rooms.get(String((data && data.code) || '').toLowerCase());
    const p = room && room.players.find(x => x.token === (data && data.token));
    if (!p) return socket.emit('rejoin:failed');
    clearTimeout(p.graceTimer);
    p.socketId = socket.id; p.connected = true; p.ip = ipHash(socket);
    socket.data.roomCode = room.code; socket.data.playerId = p.id;
    socket.join(room.code);
    socket.emit('room:joined', snapshot(room, p));
    broadcastPlayers(room);
    maybeAutoStart(room);
  }));

  socket.on('leave', guard(() => leaveCurrent(socket)));

  socket.on('room:settings', guard((data) => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || !room.isPrivate || room.ownerId !== player.id || room.state !== 'lobby') return;
    applySettings(room, data);
    emitAll(room, 'room:settings', { settings: settingsView(room) });
  }));

  socket.on('game:start', guard(() => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || !room.isPrivate || room.ownerId !== player.id) return;
    if (room.state === 'lobby' && connected(room).length < 2) return socket.emit('chat:message', { type: 'system', text: 'You need at least 2 players to start.' });
    startGame(room);
  }));

  socket.on('game:chooseWord', guard((data) => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || room.state !== 'choosing' || room.drawerId !== player.id) return;
    const i = Number(data && data.index);
    if (!Number.isInteger(i) || i < 0 || i >= room.choices.length) return;
    beginDrawing(room, room.choices[i]);
  }));

  // ---- drawing (only the current drawer may send these)
  const drawerCtx = () => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || room.state !== 'drawing' || room.drawerId !== player.id) return null;
    return room;
  };

  socket.on('draw:start', guard((d) => {
    const room = drawerCtx(); if (!room || !d || !allow(socket, 'ds', 60, 1000)) return;
    if (room.strokes.length >= MAX_STROKES) return;
    const tool = ['brush', 'eraser', 'fill'].includes(d.tool) ? d.tool : 'brush';
    const stroke = {
      id: ++room.strokeSeq, tool, color: validColor(d.color),
      size: Math.min(80, Math.max(1, Number(d.size) || 8)),
      points: [cleanPoint([d.x, d.y, d.w])]
    };
    room.strokes.push(stroke);
    room.currentStroke = tool === 'fill' ? null : stroke;
    socket.to(room.code).emit('draw:start', stroke);
  }));

  socket.on('draw:move', guard((d) => {
    const room = drawerCtx(); const s = room && room.currentStroke;
    if (!s || !d || !Array.isArray(d.points) || !allow(socket, 'dm', 80, 1000)) return;
    const pts = d.points.slice(0, 100).filter(Array.isArray).map(cleanPoint);
    if (s.points.length + pts.length > MAX_POINTS) return;
    s.points.push(...pts);
    socket.to(room.code).emit('draw:move', { id: s.id, points: pts });
  }));

  socket.on('draw:end', guard(() => { const room = drawerCtx(); if (room) room.currentStroke = null; }));

  socket.on('draw:undo', guard(() => {
    const room = drawerCtx(); if (!room || !allow(socket, 'du', 20, 2000)) return;
    room.strokes.pop(); room.currentStroke = null;
    socket.to(room.code).emit('draw:undo');
  }));

  socket.on('draw:clear', guard(() => {
    const room = drawerCtx(); if (!room || !allow(socket, 'dc', 10, 2000)) return;
    room.strokes = []; room.currentStroke = null;
    socket.to(room.code).emit('draw:clear');
  }));

  socket.on('chat:message', guard((text) => handleChat(socket, text)));

  // ---- moderation
  socket.on('mod:kick', guard((d) => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || !room.isPrivate || room.ownerId !== player.id) return;
    const t = getPlayer(room, d && d.id);
    if (t && t.id !== player.id) kickPlayer(room, t, !!d.ban);
  }));

  socket.on('mod:votekick', guard((d) => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || connected(room).length < 3) return;
    const t = getPlayer(room, d && d.id);
    if (!t || t.id === player.id || !allow(socket, 'vk', 5, 30000)) return;
    t.kickVotes.add(player.id);
    const voters = room.players.filter(x => x.id !== t.id && x.connected);
    const votes = [...t.kickVotes].filter(id => voters.some(v => v.id === id)).length;
    const needed = Math.floor(voters.length / 2) + 1;
    system(room, `${player.name} voted to kick ${t.name} (${votes}/${needed}).`);
    if (votes >= needed) kickPlayer(room, t, true, 'vote');
  }));

  socket.on('mod:report', guard((d) => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || !allow(socket, 'rep', 1, 10000)) return;
    const t = getPlayer(room, d && d.id);
    const reasons = Array.isArray(d && d.reasons) ? d.reasons.filter(r => REPORT_REASONS.includes(r)) : [];
    if (!t || !reasons.length) return;
    const line = JSON.stringify({
      at: new Date().toISOString(), room: room.code, reporter: player.name, reported: t.name,
      reportedIp: t.ip, reasons, recentChat: room.chat.slice(-20)
    });
    fs.appendFile(path.join(__dirname, 'data', 'reports.jsonl'), line + '\n', () => {});
    socket.emit('chat:message', { type: 'system', text: `Report about ${t.name} sent. Thank you.` });
  }));

  socket.on('disconnect', guard(() => {
    const { room, player } = ctxOf(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    broadcastPlayers(room);
    if (room.state === 'drawing' && allGuessed(room)) endTurn(room, 'allGuessed');
    player.graceTimer = setTimeout(() => removePlayer(room, player, 'lost connection'), GRACE_MS);
  }));
}

// ------------------------------------------------------------------ http
function start(port = process.env.PORT || 3000) {
  const app = express();
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'], objectSrc: ["'none'"], upgradeInsecureRequests: null
      }
    }
  }));
  app.get('/api/languages', (req, res) => res.json(availableLanguages()));
  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const server = http.createServer(app);
  io = new Server(server, { maxHttpBufferSize: 2e5, pingInterval: 20000, pingTimeout: 30000 });
  io.on('connection', registerSocket);
  return new Promise(resolve => server.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    console.log(`Inkling running on http://localhost:${addr.port}`);
    resolve({ server, io, port: addr.port, rooms });
  }));
}

if (require.main === module) start();
module.exports = { start };
