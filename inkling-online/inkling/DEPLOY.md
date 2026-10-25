# Put Inkling online (so friends can join from a link)

`localhost:3000` only works on your own computer. To let other people join, the game has to run on
a public server. Pick ONE option.

## Option A - Render (free, easiest)
1. Push this folder to a GitHub repository.
2. Go to https://render.com -> New -> Blueprint (or Web Service) -> pick the repo.
   `render.yaml` is already included; Render builds the Dockerfile for you.
3. When it is live you get a URL like `https://inkling-xxxx.onrender.com`.
4. Open it, press **Create private room**, press **Invite**, send the link to friends.
   The free plan sleeps after ~15 min idle, so open the site once before inviting people.

## Option B - Fly.io
```bash
fly launch --copy-config --no-deploy   # keep fly.toml, pick an app name
fly deploy
```
Keep ONE machine only (room state is in memory).

## Option C - Quick test from your own PC (temporary public link)
```bash
npm install
npm start
# in a second terminal:
npx cloudflared tunnel --url http://localhost:3000
# or: npx localtunnel --port 3000
```
Send the printed `https://....` URL to friends. It only works while your PC and the server are running.

## How friends join
Host: Create private room -> Invite -> copy the link (it is `https://YOUR-SITE/?room=CODE`).
Friend: opens the link -> is put into the room automatically (no extra button) -> host presses **Start!**.
