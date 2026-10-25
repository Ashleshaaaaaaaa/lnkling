# Inkling

A free multiplayer **draw-and-guess** game that runs in the browser.
Node.js + Express + Socket.IO on the server, plain HTML/CSS/JS (ES modules) and a `<canvas>` on the client.
There is **no build step**.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Open the page, press **Create private room**, press **Invite**, and send the link. Anyone who opens it joins the room automatically; the host then presses **Start!**. See `DEPLOY.md` to put it online - `localhost` only works on your own computer.

Requirements: **Node.js 18+** (20 recommended). Nothing else.

## Features

**Lobby / home page**
- Name, customizable avatar (color, eyes, mouth, drawn in code), language select (28 languages)
- **Play!** (public matchmaking by language) and **Create private room**
- Invite links: `/?room=CODE`
- About, What's inside, How to play, Terms / Credits / Contact dialogs

**Room settings (private-room owner)**
Players 2-20, language, draw time (15-240 s), rounds 2-10, game mode (Normal / Hidden / Combination),
word count 1-5, hints 0-5, custom words, "custom words only".

**Game**
- Drawer chooses from N words (auto-picks after 15 s), others see blanks `_ _ _` plus the length
- Hints reveal random letters evenly over the turn (never in Hidden mode)
- Guessing happens in chat; "X is close!" for one-letter-off guesses (only the guesser sees it)
- People who already guessed (and the drawer) chat privately so nobody can leak the word
- Faster guesses score more; the drawer earns the average of the guessers' points
- Turn-end screen with points, final podium (ties handled), automatic return to the lobby
- Public rooms start by themselves 5 s after two players are present

**Drawing**
- Brush (4 sizes), eraser, flood fill, undo, clear, 20 colors
- **Left click** draws with the primary color, **right click** with the secondary color
  (right-click a swatch to set the secondary color)
- Pointer Events: mouse, touch and pen with optional **pressure sensitivity**
- Strokes are stored as normalized points, so any screen size works; late joiners get the full stroke list

**Interface**
- Configurable **hotkeys** (click, press a key, reset button): B E F Z C [ ] by default, Ctrl+Z too
- Volume slider with generated sound effects (no audio files)
- Mobile layout, optional on-screen keyboard (QWERTY / QWERTZ / AZERTY), chat input top or bottom,
  chat bubbles over the board (enabled / disabled while drawing / disabled)

**Moderation**
- Owner: **Kick** and **Ban** (by hashed IP, per room)
- Everyone: **Votekick** (majority, needs 3+ players), **Mute** (local), **Report** (inappropriate, spam, cheating)
- Reports are appended to `server/data/reports.jsonl` with the last 20 chat lines
- Profanity masking via `server/blocklist.txt`

**Robustness**
- Reconnect: refresh the page and you keep your seat (30 s grace period)
- Server-authoritative: the secret word is only ever sent to the drawer; every drawing event is
  checked against "is this the current drawer?"
- Rate limits on chat, drawing, room creation, joining and reports; payloads validated and clamped
- `helmet` security headers with a strict Content-Security-Policy

## Project layout

```
inkling/
  package.json
  Dockerfile
  server/
    index.js          rooms, game loop, scoring, drawing relay, chat, moderation, HTTP
    util.js           sanitizing, guess normalization, Levenshtein
    words.js          28 languages, loads server/words/<code>.txt
    words/            en, de, es, fr word lists (add more!)
    blocklist.txt     words masked in chat / rejected as names
    data/             reports.jsonl is written here
  public/
    index.html        landing page, game screen, dialogs
    style.css         desktop + mobile styles
    js/app.js         UI, socket events, input, hotkeys, settings, moderation menus
    js/board.js       canvas strokes, replay, flood fill
    js/avatar.js      avatars drawn as SVG in code
    js/sound.js       WebAudio sound effects
  test/smoke.js       end-to-end test: 3 bots play a full game (+ kick/ban, matchmaking)
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so bans use the real client IP (`X-Forwarded-For`) |

Gameplay constants (choose time, reconnect grace, stroke limits...) are at the top of `server/index.js`.

## Customizing

- **Words:** put one word per line in `server/words/<code>.txt` (codes: en, de, fr, es, ru, ja, ...).
  Languages without a file fall back to English. Restart the server after editing.
- **Scoring:** `handleChat` (guesser points) and `endTurn` (drawer points) in `server/index.js`.
- **Colors / sizes:** `PALETTE` and `SIZES` in `public/js/app.js`; theme variables at the top of `style.css`.
- **Branding:** the logo is text in `app.js`; replace the Terms, Credits and Contact text in `index.html`.

## Deploying

Any host that supports **WebSockets and a long-running Node process** works
(Render, Railway, Fly.io, a VPS, Docker). Static-only hosts (GitHub Pages, plain Netlify) will not work.

```bash
docker build -t inkling . && docker run -p 3000:3000 inkling
```

Put it behind HTTPS (Caddy, nginx, or your platform's proxy) and set `TRUST_PROXY=1`.

**Scaling note:** room state lives in server memory, so run **one instance**. This comfortably handles
hundreds of concurrent players. To go beyond one process, move rooms to Redis and use
`@socket.io/redis-adapter` with sticky sessions - that is the main thing not included.

## Known limitations

- Room state is in memory: a server restart ends running games.
- Only English, German, Spanish and French ship with word lists (about 90-260 words each); the other
  24 languages are selectable but use English words until you add a file. A bigger list makes games better.
- Muting is client-side (per browser tab). Bans are per room and by IP hash, so shared networks share bans.
- Flood fill is pixel-based, so tiny anti-aliasing differences between browsers are possible.
- The mobile on-screen keyboard is basic and experimental.
- Terms of Service and Contact are placeholders: write your own before launching publicly.

## Legal

Inkling is an original implementation of the draw-and-guess genre. It uses no assets, names, words,
or code from skribbl.io or any other game. Fonts: Fredoka (SIL Open Font License) via Google Fonts.
If you must avoid third-party requests, delete the two Google Fonts `<link>` tags in `index.html`;
the CSS already falls back to system fonts.
