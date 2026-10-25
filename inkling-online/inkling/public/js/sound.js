// Tiny WebAudio sound effects, generated in code (no audio files needed).
let ctx = null;
let volume = 0.5;

export const setVolume = (v) => { volume = Math.min(1, Math.max(0, v)); };
export const getVolume = () => volume;

function tone(freq, start, dur, type = 'sine', gain = 0.25) {
  if (!ctx || volume <= 0) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain * volume, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  join: () => { tone(520, 0, .12); tone(700, .09, .14); },
  leave: () => { tone(500, 0, .12); tone(360, .09, .16); },
  correct: () => { tone(660, 0, .12, 'triangle'); tone(880, .1, .12, 'triangle'); tone(1175, .2, .22, 'triangle'); },
  tick: () => tone(900, 0, .06, 'square', .12),
  start: () => { tone(440, 0, .12, 'triangle'); tone(554, .12, .12, 'triangle'); tone(659, .24, .24, 'triangle'); },
  end: () => { tone(500, 0, .16, 'sawtooth', .15); tone(380, .16, .28, 'sawtooth', .15); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .13, .25, 'triangle'))
};

export function play(name) {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    if (SOUNDS[name]) SOUNDS[name]();
  } catch (_) { /* audio is optional */ }
}
