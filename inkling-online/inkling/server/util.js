'use strict';
const fs = require('fs');
const path = require('path');

// ---- profanity blocklist (one word per line in server/blocklist.txt) ----
let blockRe = null;
try {
  const lines = fs.readFileSync(path.join(__dirname, 'blocklist.txt'), 'utf8')
    .split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
  if (lines.length) {
    const esc = lines.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    blockRe = new RegExp('(?<![\\p{L}\\p{N}])(' + esc.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
  }
} catch (_) { /* no blocklist, that's fine */ }

const maskProfanity = (t) => (blockRe ? t.replace(blockRe, m => '*'.repeat(m.length)) : t);
const hasProfanity = (t) => (blockRe ? (blockRe.lastIndex = 0, blockRe.test(t)) : false);

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

function sanitizeName(name) {
  let n = clean(name).slice(0, 20);
  if (!n || hasProfanity(n)) n = 'Guest' + (100 + Math.floor(Math.random() * 900));
  return n;
}
const sanitizeChat = (text) => maskProfanity(clean(text).slice(0, 100));

// Normalise text for guess comparison. Keeps Japanese/Korean marks intact.
function normalize(s, lang) {
  let t = String(s).normalize('NFD');
  if (lang !== 'ja' && lang !== 'ko') t = t.replace(/[\u0300-\u036f]/g, '');
  return t.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

module.exports = { sanitizeName, sanitizeChat, normalize, levenshtein, shuffle, clean };
