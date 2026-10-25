'use strict';
const fs = require('fs');
const path = require('path');

const LANGUAGES = {
  en: 'English', de: 'German', bg: 'Bulgarian', cs: 'Czech', da: 'Danish', nl: 'Dutch',
  fi: 'Finnish', fr: 'French', et: 'Estonian', el: 'Greek', he: 'Hebrew', hu: 'Hungarian',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', lv: 'Latvian', mk: 'Macedonian', no: 'Norwegian',
  pt: 'Portuguese', pl: 'Polish', ro: 'Romanian', ru: 'Russian', sr: 'Serbian', sk: 'Slovakian',
  es: 'Spanish', sv: 'Swedish', tl: 'Tagalog', tr: 'Turkish'
};

const dir = path.join(__dirname, 'words');
const cache = {};

function loadWords(lang) {
  if (!LANGUAGES[lang]) lang = 'en';
  if (cache[lang]) return cache[lang];
  let file = path.join(dir, lang + '.txt');
  if (!fs.existsSync(file)) file = path.join(dir, 'en.txt'); // fall back to English
  const list = [...new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(s => s.trim()).filter(s => s && !s.startsWith('#')))];
  cache[lang] = list;
  return list;
}

// Every language is selectable; `hasWords` tells the UI which ones have a real list.
function availableLanguages() {
  return Object.entries(LANGUAGES).map(([code, name]) => ({
    code, name, hasWords: fs.existsSync(path.join(dir, code + '.txt'))
  }));
}

module.exports = { LANGUAGES, loadWords, availableLanguages };
