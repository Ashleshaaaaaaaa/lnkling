'use strict';
// End-to-end smoke test: 3 bots play a full 2-round game against a real server.
process.env.INK_FAST = '1';
const assert = require('assert');
const { io } = require('socket.io-client');
const { start } = require('../server');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});

const turnEnds = [];
(async () => {
  const { server, port } = await start(0);
  const url = `http://localhost:${port}`;
  const mk = () => io(url, { transports: ['websocket'], forceNew: true });
  const [a, b, c] = [mk(), mk(), mk()];
  const bots = [a, b, c];
  const state = new Map(bots.map(s => [s, { word: null, strokes: 0, scores: null }]));

  for (const s of bots) {
    const st = state.get(s);
    s.on('game:choices', (d) => s.emit('game:chooseWord', { index: 0 }));
    s.on('game:word', (d) => { st.word = d.word; });
    s.on('draw:start', () => { st.strokes++; });
    s.on('players', (d) => { st.scores = d.players; });
    s.on('game:phase', (d) => { if (d.state === 'drawing' && st.word === null) { /* guessers wait for drawer word */ } });
  }
  // the drawer draws a few strokes, everyone else guesses via a shared word lookup
  let current = null;
  for (const s of bots) {
    s.on('game:phase', async (d) => {
      if (d.state !== 'drawing') return;
      await wait(100);
      const st = state.get(s);
      if (st.word && !current) {
        current = st.word;
        s.emit('draw:start', { tool: 'brush', color: '#ff0000', size: 8, x: 0.1, y: 0.1 });
        s.emit('draw:move', { points: [[0.2, 0.2, 1], [0.3, 0.3, 1]] });
        s.emit('draw:end');
        s.emit('draw:start', { tool: 'fill', color: '#00ff00', size: 1, x: 0.5, y: 0.5 });
        await wait(100);
        if (turnEnds.length === 0) for (const o of bots) if (o !== s) o.emit('chat:message', 'definitely wrong guess xyz');
        await wait(100);
        for (const o of bots) if (o !== s) o.emit('chat:message', current);
      }
    });
    s.on('game:turnEnd', () => { current = null; for (const k of bots) state.get(k).word = null; });
  }

  // --- owner creates private room, two players join by code
  a.emit('room:create', { name: 'Alice', avatar: { color: 1, eyes: 2, mouth: 3 }, language: 'en' });
  const snapA = await once(a, 'room:joined');
  assert(snapA.isPrivate && snapA.ownerId === snapA.selfId, 'creator is owner');
  b.emit('room:join', { code: snapA.code, name: 'Bob' });
  c.emit('room:join', { code: snapA.code, name: '<b>Cara</b>' });
  const snapB = await once(b, 'room:joined'); await once(c, 'room:joined');
  assert.strictEqual(snapB.players.length >= 2, true);

  // non-owner can't change settings; owner can
  b.emit('room:settings', { rounds: 9 });
  a.emit('room:settings', { rounds: 2, drawTime: 15, wordCount: 3, hints: 1 });
  const upd = await once(b, 'room:settings');
  assert.strictEqual(upd.settings.rounds, 2);
  assert.strictEqual(upd.settings.drawTime, 15);

  // bad join
  const d = mk(); d.emit('room:join', { code: 'nope', name: 'x' });
  assert.strictEqual((await once(d, 'join:error')).code, 'ROOM_NOT_FOUND'); d.close();

  // --- play the whole game
  a.on('game:turnEnd', (t) => turnEnds.push(t));
  const gameEnd = once(a, 'game:end', 60000);
  a.emit('game:start');
  const end = await gameEnd;
  assert.strictEqual(turnEnds.length, 6, '2 rounds x 3 players = 6 turns, got ' + turnEnds.length);
  assert(turnEnds.every(t => t.reason === 'allGuessed'), 'reasons: ' + turnEnds.map(t => t.reason).join(','));
  assert(end.ranking.length === 3 && end.ranking[0].score > 0, 'ranking has scores');
  const strokesSeen = bots.reduce((n, s) => n + state.get(s).strokes, 0);
  assert(strokesSeen >= 6, 'strokes relayed to guessers');

  // name sanitising
  assert(!end.ranking.some(r => /[<>]/.test(r.name)), 'names are sanitised');

  // --- kick/ban
  await once(a, 'room:lobby');
  const kicked = once(c, 'kicked');
  a.emit('mod:kick', { id: end.ranking.find(r => r.name === 'bCara/b' || r.name.includes('Cara')).id, ban: true });
  assert.strictEqual((await kicked).ban, true);
  c.emit('room:join', { code: snapA.code, name: 'Cara again' });
  assert.strictEqual((await once(c, 'join:error')).code, 'BANNED');

  // --- public matchmaking
  const p1 = mk(), p2 = mk();
  p1.emit('play', { name: 'P1', language: 'en' });
  const s1 = await once(p1, 'room:joined');
  p2.emit('play', { name: 'P2', language: 'en' });
  const s2 = await once(p2, 'room:joined');
  assert.strictEqual(s1.code, s2.code, 'public players land in the same room');
  assert(!s1.isPrivate);
  const started = await once(p1, 'game:start', 5000);
  assert(started, 'public room auto-starts with 2 players');

  [...bots, p1, p2].forEach(s => s.close());
  server.close();
  console.log('All smoke tests passed.');
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
