import { avatarSVG, COUNTS } from './avatar.js';
import { Board } from './board.js';
import { play, setVolume } from './sound.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const isMobile = () => window.matchMedia('(max-width: 880px)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } }
};

// ---------------------------------------------------------------- preferences
const DEFAULT_HOTKEYS = { brush: 'b', eraser: 'e', fill: 'f', undo: 'z', clear: 'c', sizeUp: ']', sizeDown: '[' };
const HOTKEY_LABELS = { brush: 'Brush', eraser: 'Eraser', fill: 'Fill', undo: 'Undo', clear: 'Clear canvas', sizeUp: 'Bigger brush', sizeDown: 'Smaller brush' };
const prefs = Object.assign({
  name: '', avatar: { color: 0, eyes: 0, mouth: 0 }, lang: 'en', volume: 50, pressure: 'off',
  kbd: 'off', kbdLayout: 'qwerty', chatPos: 'bottom', bubbles: 'on', hotkeys: { ...DEFAULT_HOTKEYS }
}, store.get('inkling.prefs', {}));
prefs.hotkeys = Object.assign({}, DEFAULT_HOTKEYS, prefs.hotkeys);
const savePrefs = () => store.set('inkling.prefs', prefs);
setVolume(prefs.volume / 100);

// ---------------------------------------------------------------- state
const socket = io();
const S = {
  me: null, code: null, isPrivate: true, ownerId: null, settings: null, players: [], state: 'lobby',
  round: 0, rounds: 0, drawerId: null, endsAt: null, offset: 0, word: null, mask: null, hidden: false,
  choices: null, autoStartAt: null, lastTurn: null, lastEnd: null,
  muted: new Set(JSON.parse(sessionStorage.getItem('inkling.muted') || '[]'))
};
let LANGS = [];
const board = new Board($('#board'));
const nowServer = () => Date.now() + S.offset;
const syncClock = (serverNow) => { if (serverNow) S.offset = serverNow - Date.now(); };
const me = () => S.players.find(p => p.id === S.me);
const canDraw = () => S.state === 'drawing' && S.drawerId === S.me;
const session = {
  get: () => { try { return JSON.parse(sessionStorage.getItem('inkling.session')); } catch (_) { return null; } },
  set: (v) => sessionStorage.setItem('inkling.session', JSON.stringify(v)),
  clear: () => sessionStorage.removeItem('inkling.session')
};

// ---------------------------------------------------------------- landing page
const LOGO_COLORS = ['#ff7a45', '#ffd23f', '#5bd18b', '#4cc9f0', '#b7a6ff', '#ff8fb1', '#ffd23f'];
$('#logo').append(...[...'Inkling'].map((ch, i) => {
  const s = el('span', null, ch);
  s.style.color = LOGO_COLORS[i % LOGO_COLORS.length];
  s.style.transform = `rotate(${[-6, 4, -3, 5, -5, 3, -4][i]}deg) translateY(${[0, -4, 3, -2, 4, -3, 1][i]}px)`;
  return s;
}));

function renderAvatarPick() { $('#av-preview').innerHTML = avatarSVG(prefs.avatar); }
$$('[data-av]').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.av;
  prefs.avatar[k] = (prefs.avatar[k] + Number(b.dataset.d) + COUNTS[k]) % COUNTS[k];
  savePrefs(); renderAvatarPick();
}));
$('#av-rand').addEventListener('click', () => {
  for (const k of Object.keys(COUNTS)) prefs.avatar[k] = Math.floor(Math.random() * COUNTS[k]);
  savePrefs(); renderAvatarPick();
});
renderAvatarPick();
$('#name').value = prefs.name || '';
$('#name').addEventListener('input', () => { prefs.name = $('#name').value; savePrefs(); });

fetch('/api/languages').then(r => r.json()).then(list => {
  LANGS = list;
  const sel = $('#lang');
  for (const l of list) sel.append(new Option(l.hasWords ? l.name : `${l.name} (English words)`, l.code));
  sel.value = list.some(l => l.code === prefs.lang) ? prefs.lang : 'en';
  if (S.settings) buildLobby();
}).catch(() => { $('#lang').append(new Option('English', 'en')); });
$('#lang').addEventListener('change', () => { prefs.lang = $('#lang').value; savePrefs(); });

let inviteCode = new URLSearchParams(location.search).get('room');
if (inviteCode) { $('#join-note').hidden = false; $('#join-note').textContent = 'Joining your friends\u2019 room\u2026'; }
let inviteTried = false;
function autoJoinInvite() {
  if (!inviteCode || inviteTried) return;
  inviteTried = true;
  socket.emit('room:join', { code: inviteCode, ...profile() });
}

const profile = () => ({ name: $('#name').value, avatar: prefs.avatar, language: $('#lang').value || 'en' });
$('#play').addEventListener('click', () => {
  $('#err').textContent = '';
  if (inviteCode) { inviteTried = true; socket.emit('room:join', { code: inviteCode, ...profile() }); } else socket.emit('play', profile());
});
$('#create').addEventListener('click', () => { $('#err').textContent = ''; socket.emit('room:create', profile()); });
const JOIN_ERRORS = {
  ROOM_NOT_FOUND: 'That room does not exist any more. Press Create private room to start a new one.',
  ROOM_FULL: 'That room is full.', BANNED: 'You were banned from that room.', RATE_LIMIT: 'Too many tries. Wait a moment and try again.'
};
socket.on('join:error', (d) => {
  $('#err').textContent = JOIN_ERRORS[d.code] || 'Could not join the room.';
  // the invite is no longer usable: drop it so Play / Create work normally again
  inviteCode = null; $('#join-note').hidden = true; history.replaceState(null, '', '/');
});

$$('[data-open]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.open).showModal()));

function info(title, text) { $('#info-title').textContent = title; $('#info-text').textContent = text; $('#dlg-info').showModal(); }

// ---------------------------------------------------------------- connection / rejoin
socket.on('connect', () => {
  let s = session.get();
  // an invite to a different room than the saved seat wins over the old seat
  if (s && inviteCode && !inviteTried && String(s.code).toLowerCase() !== inviteCode.toLowerCase()) { session.clear(); s = null; }
  if (s) socket.emit('rejoin', s); else autoJoinInvite();
});
socket.on('rejoin:failed', () => { session.clear(); showLanding(); autoJoinInvite(); });

function showLanding() {
  $('#game').hidden = true; $('#landing').hidden = false;
  S.me = null; S.code = null;
  document.body.classList.remove('drawing-now');
}

socket.on('room:joined', (d) => {
  S.me = d.selfId; S.code = d.code; S.isPrivate = d.isPrivate; S.ownerId = d.ownerId; S.settings = d.settings;
  S.players = d.players; S.state = d.state; S.round = d.round; S.rounds = d.rounds; S.drawerId = d.drawerId;
  S.endsAt = d.endsAt; S.mask = d.mask; S.hidden = d.hidden; S.word = d.word || d.revealWord; S.choices = d.choices;
  S.autoStartAt = d.autoStartAt; syncClock(d.serverNow);
  session.set({ code: d.code, token: d.token });
  if (inviteCode) history.replaceState(null, '', '/');
  $('#landing').hidden = true; $('#game').hidden = false;
  board.setStrokes(d.strokes);
  $('#messages').replaceChildren();
  S.lobbyBuilt = false;
  fitBoard(); renderAll();
});

socket.on('kicked', (d) => {
  session.clear(); showLanding();
  info(d.ban ? 'You were banned' : 'You were kicked', d.ban ? 'You can no longer join that room.' : 'The room owner removed you from the room.');
});

$('#btn-leave').addEventListener('click', () => { socket.emit('leave'); session.clear(); showLanding(); });

// ---------------------------------------------------------------- server events
socket.on('players', (d) => {
  const before = S.players.length;
  S.players = d.players; S.ownerId = d.ownerId;
  if (S.players.length > before && before) play('join'); else if (S.players.length < before) play('leave');
  renderPlayers(); renderTop();
  if (S.state === 'lobby') syncLobby();
});
socket.on('room:settings', (d) => { S.settings = d.settings; syncLobby(); renderTop(); });
socket.on('room:lobby', (d) => {
  Object.assign(S, { state: 'lobby', settings: d.settings, ownerId: d.ownerId, autoStartAt: d.autoStartAt, drawerId: null, word: null, mask: null, round: 0 });
  syncClock(d.serverNow); board.clearAll(); S.lobbyBuilt = false; renderAll();
});
socket.on('lobby:countdown', (d) => { syncClock(d.serverNow); S.autoStartAt = d.autoStartAt; syncLobby(); });
socket.on('game:start', () => { play('start'); S.lastEnd = null; });
socket.on('game:phase', (d) => {
  syncClock(d.serverNow);
  Object.assign(S, { state: d.state, round: d.round, rounds: d.rounds, drawerId: d.drawerId, endsAt: d.endsAt, hidden: d.hidden });
  if (d.state === 'choosing') { board.clearAll(); S.word = null; S.mask = null; S.choices = null; }
  renderAll();
});
socket.on('game:choices', (d) => { S.choices = d.choices; renderOverlay(); });
socket.on('game:word', (d) => { S.word = d.word; renderTop(); });
socket.on('game:mask', (d) => { S.mask = d.mask; S.hidden = d.hidden; renderTop(); });
socket.on('game:turnEnd', (d) => {
  syncClock(d.serverNow);
  Object.assign(S, { state: 'turnEnd', word: d.word, endsAt: d.endsAt, lastTurn: d });
  play('end'); renderAll();
});
socket.on('game:end', (d) => {
  syncClock(d.serverNow);
  Object.assign(S, { state: 'gameEnd', lastEnd: d, endsAt: d.endsAt, drawerId: null });
  play('win'); renderAll();
});
socket.on('chat:message', addMessage);

socket.on('draw:start', (s) => board.addStroke(s));
socket.on('draw:move', (d) => board.appendPoints(d.id, d.points));
socket.on('draw:undo', () => board.undo());
socket.on('draw:clear', () => board.clearAll());

// ---------------------------------------------------------------- rendering
function renderAll() { renderTop(); renderPlayers(); renderOverlay(); renderLobbyVisibility(); updateToolbarState(); }

function renderTop() {
  const t = $('#hinttitle'), w = $('#word');
  const drawer = S.players.find(p => p.id === S.drawerId);
  $('#roundinfo').textContent = S.round > 0 ? `Round ${S.round} of ${S.rounds}` : (S.state === 'lobby' ? 'Lobby' : '');
  w.replaceChildren();
  const m = me();
  if (S.state === 'drawing') {
    if (S.drawerId === S.me) { t.textContent = 'Draw this'; w.textContent = S.word || ''; }
    else if (m && m.hasGuessed) { t.textContent = 'You guessed it!'; w.textContent = S.word || ''; }
    else {
      t.textContent = 'Guess this';
      if (S.hidden || !S.mask) w.textContent = '? ? ?';
      else {
        w.append(S.mask.map(c => (c === ' ' ? '\u00a0\u00a0' : c)).join(' '));
        const n = S.mask.filter(c => c !== ' ' && c !== '-').length;
        w.append(el('small', null, `(${n})`));
      }
    }
  } else if (S.state === 'turnEnd') { t.textContent = 'The word was'; w.textContent = S.word || ''; }
  else if (S.state === 'choosing') { t.textContent = S.drawerId === S.me ? 'Choose a word' : `${drawer ? drawer.name : 'Someone'} is choosing a word`; }
  else if (S.state === 'gameEnd') { t.textContent = 'Game over'; }
  else { t.textContent = S.isPrivate ? 'Waiting for the owner to start' : 'Waiting for players'; }
}

function renderPlayers() {
  const box = $('#players');
  const sorted = S.players.slice().sort((a, b) => b.score - a.score);
  box.replaceChildren(...sorted.map((p, i) => {
    const b = el('button', 'player'); b.type = 'button';
    if (p.hasGuessed) b.classList.add('guessed');
    if (p.isDrawer) b.classList.add('drawer');
    if (!p.connected) b.classList.add('offline');
    const rank = el('span', 'rank', `#${i + 1}`);
    const av = el('span', 'av'); av.innerHTML = avatarSVG(p.avatar);
    const info = el('div');
    const name = el('div', 'pname', p.name);
    if (p.id === S.me) name.append(el('span', 'tag', '(you)'));
    if (p.isOwner) name.append(el('span', 'tag', 'owner'));
    const meta = el('div', 'pmeta', `${p.score} pts${p.isDrawer ? ' - drawing' : ''}${p.connected ? '' : ' - offline'}`);
    info.append(name, meta);
    b.append(rank, av, info);
    b.addEventListener('click', () => openPlayerMenu(p));
    return b;
  }));
}

function renderLobbyVisibility() {
  $('#lobby').hidden = S.state !== 'lobby';
  if (S.state === 'lobby' && !S.lobbyBuilt) buildLobby();
  if (S.state === 'lobby') syncLobby();
}

// ---- overlay (word choice, turn end, podium)
function renderOverlay() {
  const o = $('#overlay');
  o.replaceChildren();
  if (S.state === 'choosing') {
    const drawer = S.players.find(p => p.id === S.drawerId);
    if (S.drawerId === S.me && S.choices) {
      o.append(el('h2', null, 'Choose a word'));
      const box = el('div', 'choices');
      S.choices.forEach((w, i) => {
        const b = el('button', 'btn primary', w); b.type = 'button';
        b.addEventListener('click', () => { socket.emit('game:chooseWord', { index: i }); S.choices = null; o.hidden = true; });
        box.append(b);
      });
      const cc = el('p', 'note'); cc.id = 'choose-count';
      o.append(box, cc);
      o.hidden = false;
    } else if (S.drawerId !== S.me) {
      const wrap = el('div');
      const av = el('div', 'av-big'); av.style.margin = '0 auto 8px'; av.innerHTML = avatarSVG(drawer && drawer.avatar);
      wrap.append(av, el('h2', null, `${drawer ? drawer.name : 'Someone'} is choosing a word`));
      o.append(wrap); o.hidden = false;
    } else o.hidden = true;
  } else if (S.state === 'turnEnd' && S.lastTurn) {
    o.append(el('p', 'note', 'The word was'), el('p', 'bigword', S.lastTurn.word));
    const ul = el('ul', 'score-list');
    S.lastTurn.scores.slice().sort((a, b) => b.delta - a.delta).forEach(sc => {
      const p = S.players.find(x => x.id === sc.id); if (!p) return;
      const li = el('li'); li.append(el('span', null, p.name), el('span', sc.delta > 0 ? 'plus' : 'note', sc.delta > 0 ? `+${sc.delta}` : '0'));
      ul.append(li);
    });
    o.append(ul); o.hidden = false;
  } else if (S.state === 'gameEnd' && S.lastEnd) {
    const r = S.lastEnd.ranking;
    const tie = r.length > 1 && r[0].score === r[1].score;
    o.append(el('h2', null, !r[0] ? 'Game over' : tie ? "It's a tie!" : `${r[0].name} wins!`));
    const pod = el('div', 'podium');
    [1, 0, 2].forEach(i => {
      const p = r[i]; if (!p) return;
      const step = el('div', `step p${i + 1}`);
      const av = el('div', 'av'); av.innerHTML = avatarSVG(p.avatar);
      step.append(av, el('b', null, p.name), el('span', null, `${p.score}`));
      pod.append(step);
    });
    const ul = el('ul', 'score-list');
    r.forEach((p, i) => { const li = el('li'); li.append(el('span', null, `${i + 1}. ${p.name}`), el('span', null, `${p.score}`)); ul.append(li); });
    o.append(pod, ul); o.hidden = false;
  } else o.hidden = true;
}

// ---- lobby / room settings
const SETTING_DEFS = [
  { key: 'maxPlayers', label: 'Players', opts: () => range(2, 20) },
  { key: 'language', label: 'Language', opts: () => LANGS.length ? LANGS.map(l => [l.code, l.name]) : [['en', 'English']] },
  { key: 'drawTime', label: 'Draw time (seconds)', opts: () => [15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180, 210, 240] },
  { key: 'rounds', label: 'Rounds', opts: () => range(2, 10) },
  { key: 'mode', label: 'Game mode', opts: () => [['normal', 'Normal'], ['hidden', 'Hidden'], ['combination', 'Combination']] },
  { key: 'wordCount', label: 'Word count (choices)', opts: () => range(1, 5) },
  { key: 'hints', label: 'Hints', opts: () => range(0, 5) }
];
function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

function buildLobby() {
  const box = $('#lobby');
  box.replaceChildren();
  const inner = el('div', 'lobby-inner');
  inner.append(el('h2', null, S.isPrivate ? 'Private room' : 'Public room'));
  const grid = el('div', 'lobby-grid');
  for (const def of SETTING_DEFS) {
    const label = el('label', null, def.label);
    const sel = el('select'); sel.dataset.key = def.key;
    for (const o of def.opts()) { const [v, t] = Array.isArray(o) ? o : [o, o]; sel.append(new Option(t, v)); }
    label.append(sel); grid.append(label);
  }
  const cw = el('label', 'full', 'Custom words (separated by commas or new lines)');
  const ta = el('textarea'); ta.dataset.key = 'customWordsText'; ta.maxLength = 20000; ta.placeholder = 'pancake, space cat, dancing robot';
  cw.append(ta);
  const co = el('label', 'full check');
  const cb = el('input'); cb.type = 'checkbox'; cb.dataset.key = 'customOnly';
  co.append(cb, document.createTextNode('Use custom words only'));
  grid.append(cw, co);
  inner.append(grid);
  const actions = el('div', 'lobby-actions');
  const start = el('button', 'btn primary big', 'Start!'); start.id = 'start-btn'; start.type = 'button';
  start.addEventListener('click', () => socket.emit('game:start'));
  const status = el('p', 'note'); status.id = 'lobby-status';
  const inv = el('button', 'btn', 'Invite friends'); inv.type = 'button'; inv.addEventListener('click', openInvite);
  actions.append(start, status, inv);
  inner.append(actions);
  box.append(inner);
  let t = null;
  const send = () => { if (S.ownerId === S.me && S.isPrivate) socket.emit('room:settings', readSettings()); };
  box.addEventListener('change', send);
  ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(send, 400); });
  S.lobbyBuilt = true;
  syncLobby();
}

function readSettings() {
  const out = {};
  $$('#lobby [data-key]').forEach(c => { out[c.dataset.key] = c.type === 'checkbox' ? c.checked : c.value; });
  return out;
}

function syncLobby() {
  if (S.state !== 'lobby' || !S.settings) return;
  if (!S.lobbyBuilt) return buildLobby();
  const isOwner = S.isPrivate && S.ownerId === S.me;
  $$('#lobby [data-key]').forEach(c => {
    const v = S.settings[c.dataset.key];
    if (document.activeElement !== c) { if (c.type === 'checkbox') c.checked = !!v; else c.value = String(v); }
    c.disabled = !isOwner;
  });
  const start = $('#start-btn'), status = $('#lobby-status');
  if (!start) return;
  const online = S.players.filter(p => p.connected).length;
  start.hidden = !isOwner;
  start.disabled = online < 2;
  if (isOwner) status.textContent = online < 2 ? 'You need at least 2 players. Invite your friends!' : `${online} players ready.`;
  else if (S.isPrivate) status.textContent = 'Waiting for the room owner to start the game.';
  else status.textContent = online < 2 ? 'Waiting for more players...' : 'Game starting soon...';
  status.dataset.countdown = !S.isPrivate && S.autoStartAt ? '1' : '';
}

// ---------------------------------------------------------------- timer
let lastTick = null;
setInterval(() => {
  const clock = $('#clock');
  if (S.state === 'lobby' && S.autoStartAt && !S.isPrivate) {
    const s = Math.max(0, Math.ceil((S.autoStartAt - nowServer()) / 1000));
    const st = $('#lobby-status'); if (st) st.textContent = `Game starts in ${s}s...`;
  }
  if (!S.endsAt || !['choosing', 'drawing', 'turnEnd', 'gameEnd'].includes(S.state)) { clock.textContent = '--'; clock.classList.remove('low'); return; }
  const left = Math.max(0, Math.ceil((S.endsAt - nowServer()) / 1000));
  clock.textContent = left;
  const low = S.state === 'drawing' && left <= 10;
  clock.classList.toggle('low', low);
  if (low && left > 0 && lastTick !== left) { lastTick = left; play('tick'); }
  const cc = $('#choose-count'); if (cc) cc.textContent = `Picking automatically in ${left}s`;
}, 250);

// ---------------------------------------------------------------- chat
function addMessage(m) {
  if (m.fromId && S.muted.has(m.fromId) && (m.type === 'normal' || m.type === 'guessed')) return;
  const box = $('#messages');
  const d = el('div', `msg ${m.type}`);
  if ((m.type === 'normal' || m.type === 'guessed') && m.name) { d.append(el('b', null, m.name + ':'), document.createTextNode(' ' + m.text)); }
  else d.textContent = m.text;
  box.append(d);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  if (m.type === 'correct') play('correct');
  if (['normal', 'correct', 'close'].includes(m.type)) {
    const b = el('div', 'bubble' + (m.type === 'correct' ? ' good' : ''), m.type === 'normal' ? `${m.name}: ${m.text}` : m.text);
    const bb = $('#bubbles'); bb.append(b); setTimeout(() => b.remove(), 4600);
    while (bb.children.length > 4) bb.firstChild.remove();
  }
}

$('#chatform').addEventListener('submit', (e) => {
  e.preventDefault();
  const i = $('#chatinput'), v = i.value.trim();
  if (v) socket.emit('chat:message', v);
  i.value = '';
});

// on-screen keyboard (experimental, mobile only)
const KBD_LAYOUTS = { qwerty: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'], qwertz: ['qwertzuiop', 'asdfghjkl', 'yxcvbnm'], azerty: ['azertyuiop', 'qsdfghjklm', 'wxcvbn'] };
function renderKeyboard() {
  const on = prefs.kbd === 'on' && isMobile();
  const input = $('#chatinput'), kbd = $('#kbd');
  kbd.hidden = !on; input.readOnly = on; input.inputMode = on ? 'none' : 'text';
  if (!on) return;
  kbd.replaceChildren();
  const press = (fn) => (e) => { e.preventDefault(); fn(); input.focus({ preventScroll: true }); };
  for (const row of KBD_LAYOUTS[prefs.kbdLayout] || KBD_LAYOUTS.qwerty) {
    const r = el('div', 'kbd-row');
    for (const ch of row) { const b = el('button', null, ch); b.type = 'button'; b.addEventListener('click', press(() => { if (input.value.length < 100) input.value += ch; })); r.append(b); }
    kbd.append(r);
  }
  const last = el('div', 'kbd-row');
  const back = el('button', null, 'Delete'); back.type = 'button'; back.addEventListener('click', press(() => { input.value = input.value.slice(0, -1); }));
  const sp = el('button', null, 'Space'); sp.type = 'button'; sp.style.flex = '3'; sp.addEventListener('click', press(() => { input.value += ' '; }));
  const go = el('button', null, 'Send'); go.type = 'button'; go.addEventListener('click', () => $('#chatform').requestSubmit());
  last.append(back, sp, go); kbd.append(last);
}

// ---------------------------------------------------------------- drawing tools
const PALETTE = ['#ffffff', '#c1c1c1', '#ef130b', '#ff7100', '#ffe400', '#00cc00', '#00b2ff', '#231fd3', '#a300ba', '#d37caa',
  '#000000', '#4c4c4c', '#740b07', '#c23800', '#e8a200', '#005510', '#00569e', '#0e0865', '#550069', '#a0522d'];
const SIZES = [4, 10, 20, 36];
const tool = { name: 'brush', c1: '#000000', c2: '#ffffff', size: 10 };

function renderToolbar() {
  const pal = $('#palette');
  PALETTE.forEach(c => {
    const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', `Color ${c}`);
    b.addEventListener('click', () => { tool.c1 = c; if (tool.name === 'eraser') tool.name = 'brush'; updateToolbarState(); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); tool.c2 = c; updateToolbarState(); });
    pal.append(b);
  });
  const sz = $('#sizes');
  SIZES.forEach(s => {
    const b = el('button', 'size-btn'); b.type = 'button'; b.dataset.size = s; b.setAttribute('aria-label', `Brush size ${s}`);
    const i = el('i'); i.style.width = i.style.height = `${Math.max(4, s * 0.7)}px`; b.append(i);
    b.addEventListener('click', () => { tool.size = s; updateToolbarState(); });
    sz.append(b);
  });
  $$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => { tool.name = b.dataset.tool; updateToolbarState(); }));
  $('#t-undo').addEventListener('click', doUndo);
  $('#t-clear').addEventListener('click', doClear);
}
function updateToolbarState() {
  $('#sw1').style.background = tool.c1; $('#sw2').style.background = tool.c2;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool.name));
  $$('.size-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === tool.size));
  $('#toolbar').classList.toggle('disabled', !canDraw());
  $('#board').classList.toggle('locked', !canDraw());
}
function doUndo() { if (!canDraw() || !board.strokes.length) return; board.undo(); socket.emit('draw:undo'); }
function doClear() { if (!canDraw() || !board.strokes.length) return; board.clearAll(); socket.emit('draw:clear'); }
renderToolbar(); updateToolbarState();

// pointer input: one code path for mouse, touch and pen
const canvas = $('#board');
let cur = null, buf = [], flushTimer = null, lastPt = null;
const toNorm = (e) => {
  const r = canvas.getBoundingClientRect();
  const w = prefs.pressure === 'on' && e.pointerType !== 'mouse' && e.pressure > 0 ? 0.3 + 1.4 * e.pressure : 1;
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), Math.round(w * 100) / 100];
};
function flush() {
  if (buf.length) { socket.emit('draw:move', { points: buf }); buf = []; }
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!canDraw() || (e.button !== 0 && e.button !== 2) || cur) return;
  e.preventDefault();
  const color = e.button === 2 ? tool.c2 : tool.c1;
  const pt = toNorm(e);
  const stroke = { id: 'L' + Date.now(), tool: tool.name, color, size: tool.size, points: [pt] };
  socket.emit('draw:start', { tool: tool.name, color, size: tool.size, x: pt[0], y: pt[1], w: pt[2] });
  board.addStroke(stroke);
  if (tool.name === 'fill') return;
  canvas.setPointerCapture(e.pointerId);
  cur = stroke; lastPt = pt; buf = [];
  document.body.classList.add('drawing-now');
  flushTimer = setInterval(flush, 40);
});
canvas.addEventListener('pointermove', (e) => {
  if (!cur) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (events.length ? events : [e])) {
    const pt = toNorm(ev);
    if (Math.hypot(pt[0] - lastPt[0], pt[1] - lastPt[1]) < 0.002) continue;
    cur.points.push(pt); board.segment(cur, cur.points.length - 1);
    buf.push(pt); lastPt = pt;
  }
});
function endStroke() {
  if (!cur) return;
  clearInterval(flushTimer); flush(); socket.emit('draw:end');
  cur = null; document.body.classList.remove('drawing-now');
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('lostpointercapture', endStroke);

// keep the 4:3 board as large as the space allows
const wrap = $('#canvas-wrap'), frame = $('#frame');
function fitBoard() {
  const r = wrap.getBoundingClientRect();
  if (!r.width) return;
  let w = r.width, h = w * 0.75;
  if (!isMobile() && r.height && h > r.height) { h = r.height; w = h * 4 / 3; }
  frame.style.width = Math.floor(w) + 'px'; frame.style.height = Math.floor(h) + 'px';
}
new ResizeObserver(fitBoard).observe(wrap);
window.addEventListener('resize', () => { fitBoard(); renderKeyboard(); });

// ---------------------------------------------------------------- hotkeys
let rebinding = null;
document.addEventListener('keydown', (e) => {
  if (rebinding) {
    e.preventDefault();
    if (e.key !== 'Escape') {
      const k = e.key.toLowerCase();
      for (const n of Object.keys(prefs.hotkeys)) if (prefs.hotkeys[n] === k) prefs.hotkeys[n] = prefs.hotkeys[rebinding]; // swap on conflict
      prefs.hotkeys[rebinding] = k; savePrefs();
    }
    rebinding = null; renderHotkeys(); return;
  }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (document.querySelector('dialog[open]') || !canDraw()) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return doUndo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const name = Object.keys(prefs.hotkeys).find(n => prefs.hotkeys[n] === k);
  if (!name) return;
  e.preventDefault();
  if (name === 'undo') doUndo();
  else if (name === 'clear') doClear();
  else if (name === 'sizeUp') { tool.size = SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(tool.size) + 1)]; }
  else if (name === 'sizeDown') { tool.size = SIZES[Math.max(0, SIZES.indexOf(tool.size) - 1)]; }
  else tool.name = name;
  updateToolbarState();
});

function renderHotkeys() {
  const box = $('#hotkeys');
  box.replaceChildren();
  for (const n of Object.keys(DEFAULT_HOTKEYS)) {
    const b = el('button', rebinding === n ? 'listening' : '', rebinding === n ? 'press a key' : prefs.hotkeys[n]); b.type = 'button';
    b.addEventListener('click', () => { rebinding = n; renderHotkeys(); });
    box.append(el('span', null, HOTKEY_LABELS[n]), b);
  }
}
$('#hk-reset').addEventListener('click', () => { prefs.hotkeys = { ...DEFAULT_HOTKEYS }; savePrefs(); rebinding = null; renderHotkeys(); });

// ---------------------------------------------------------------- settings dialog
function applyPrefs() {
  document.body.classList.toggle('chat-top', prefs.chatPos === 'top');
  document.body.classList.toggle('bubbles-off', prefs.bubbles === 'off');
  document.body.classList.toggle('bubbles-notdrawing', prefs.bubbles === 'notdrawing');
  setVolume(prefs.volume / 100);
  renderKeyboard();
}
$('#btn-settings').addEventListener('click', () => {
  $('#volume').value = prefs.volume; $('#vol-out').textContent = prefs.volume + '%';
  $('#opt-pressure').value = prefs.pressure; $('#opt-kbd').value = prefs.kbd; $('#opt-kbdlayout').value = prefs.kbdLayout;
  $('#opt-chatpos').value = prefs.chatPos; $('#opt-bubbles').value = prefs.bubbles;
  rebinding = null; renderHotkeys(); $('#dlg-settings').showModal();
});
$('#dlg-settings').addEventListener('close', () => { rebinding = null; });
$('#volume').addEventListener('input', (e) => { prefs.volume = Number(e.target.value); $('#vol-out').textContent = prefs.volume + '%'; savePrefs(); applyPrefs(); play('tick'); });
for (const [id, key] of [['opt-pressure', 'pressure'], ['opt-kbd', 'kbd'], ['opt-kbdlayout', 'kbdLayout'], ['opt-chatpos', 'chatPos'], ['opt-bubbles', 'bubbles']]) {
  $('#' + id).addEventListener('change', (e) => { prefs[key] = e.target.value; savePrefs(); applyPrefs(); });
}
applyPrefs();

// ---------------------------------------------------------------- invite
function openInvite() {
  $('#invite-link').value = `${location.origin}/?room=${S.code}`;
  $('#invite-copy').textContent = 'Click to copy';
  $('#dlg-invite').showModal();
}
$('#btn-invite').addEventListener('click', openInvite);
$('#invite-copy').addEventListener('click', async () => {
  const input = $('#invite-link');
  try { await navigator.clipboard.writeText(input.value); } catch (_) { input.select(); document.execCommand('copy'); }
  $('#invite-copy').textContent = 'Copied!';
});
$('#invite-link').addEventListener('focus', (e) => e.target.select());

// ---------------------------------------------------------------- player menu / moderation
let menuTarget = null;
function openPlayerMenu(p) {
  if (p.id === S.me) return;
  menuTarget = p;
  $('#pm-name').textContent = p.name;
  const box = $('#pm-actions'); box.replaceChildren();
  const add = (label, cls, fn) => { const b = el('button', 'btn ' + cls, label); b.type = 'button'; b.addEventListener('click', () => { $('#dlg-player').close(); fn(); }); box.append(b); };
  if (S.isPrivate && S.ownerId === S.me) {
    add('Kick', 'danger', () => socket.emit('mod:kick', { id: p.id, ban: false }));
    add('Ban', 'danger', () => socket.emit('mod:kick', { id: p.id, ban: true }));
  }
  if (S.players.filter(x => x.connected).length >= 3) add('Votekick', '', () => socket.emit('mod:votekick', { id: p.id }));
  const muted = S.muted.has(p.id);
  add(muted ? 'Unmute' : 'Mute', '', () => {
    if (muted) S.muted.delete(p.id); else S.muted.add(p.id);
    sessionStorage.setItem('inkling.muted', JSON.stringify([...S.muted]));
    addMessage({ type: 'system', text: `${p.name} was ${muted ? 'unmuted' : 'muted'} (only for you).` });
  });
  add('Report', '', () => {
    $('#rp-name').textContent = p.name;
    $$('#dlg-report input').forEach(c => { c.checked = false; });
    $('#dlg-report').showModal();
  });
  $('#dlg-player').showModal();
}
$('#rp-send').addEventListener('click', () => {
  const reasons = $$('#dlg-report input:checked').map(c => c.value);
  if (!reasons.length || !menuTarget) return;
  socket.emit('mod:report', { id: menuTarget.id, reasons });
  $('#dlg-report').close();
});

// first paint
fitBoard();
