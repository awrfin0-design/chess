# Rookery: real-time multiplayer chess

A complete, self-hostable web app for playing chess against other people in real time.
It works like the big chess sites: a lobby, matchmaking, live clocks, ratings, chat and spectating.

## Features

- **Quick pairing**: one click on a time control (1+0 … 30+20) finds an opponent or waits for one.
- **Lobby**: create a custom game (any time control, casual/rated, pick your side); others join with one click.
- **Play a friend**: create a challenge link and send it to anyone.
- **Server-authoritative play**: every move is validated on the server, which also detects checkmate, stalemate, threefold repetition, the fifty-move rule and insufficient material.
- **Clocks** with increment. They start after both players' first moves. If no first move is made within 30 s, the game is aborted. When a player's flag falls and the opponent has no mating material, the game is a draw.
- **In-game actions**: resign (with confirmation), abort, draw offers, takebacks, rematch, "new opponent".
  If your opponent disconnects for 30 s, you can claim victory or call a draw.
- **Board**: drag-and-drop or click-to-move, legal-move hints, premoves, promotion picker,
  last-move and check highlights, animations, flip board, captured material, sounds.
- **Move list & replay**: step through moves with the arrows or the keyboard (← → Home End, `f` flips the board).
  Every finished game has a permanent URL and a PGN download.
- **Accounts & ratings**: register/sign in (scrypt-hashed passwords, httpOnly session cookies).
  There are separate **Glicko-2** ratings for bullet, blitz, rapid and classical. Ratings marked `?` are provisional.
- **Guests** can play casual games right away without signing up.
- **Profiles** (ratings, win/loss/draw record, game history with thumbnails) and a **leaderboard**.
- **Spectating**: a "Live games" tab with mini-boards; anyone can open a game URL and watch.
- **Chat** in every game.
- **Settings**: dark/light/system theme, four board colors, sound on/off. The layout works on phones.

## Running it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
npm install
npm start
```

Open http://localhost:3000. To try multiplayer on one machine, use a normal window plus a private/incognito window
(or a second browser) so each one has its own identity.

Development mode with auto-restart: `npm run dev`. Tests: `npm test`.

### Configuration (environment variables)

| Variable      | Default            | Meaning                                                         |
|---------------|--------------------|-----------------------------------------------------------------|
| `PORT`        | `3000`             | HTTP port                                                       |
| `HOST`        | `0.0.0.0`          | Bind address                                                    |
| `DB_FILE`     | `./data/chess.db`  | SQLite database file (created automatically)                    |
| `TRUST_PROXY` | unset              | Set to `1` behind a reverse proxy/HTTPS terminator (secure cookies, real client IPs) |

### Docker

```bash
docker build -t rookery .
docker run -p 3000:3000 -v rookery-data:/data rookery
```

### Deploying

Rookery is a **Node.js server**, not a static website. The server runs the games, the clocks, the live
connections and the database. Static hosts (**Cloudflare Pages, GitHub Pages, Netlify, Vercel static**) can only
serve files, so on them the page shows just the header and a "server isn't running" message.
Use a host that runs Node or Docker.

**Render (free, easiest)**
1. Sign in at https://render.com with your GitHub account.
2. Click **New → Blueprint**, pick this repository and click **Apply**. The included `render.yaml` sets everything up.
   (Or **New → Web Service**: build command `npm ci`, start command `npm start`, environment variable `TRUST_PROXY=1`.)
3. After a few minutes you get a URL like `https://rookery-xxxx.onrender.com`. Share it and play.

Free-plan caveats on Render: the server sleeps after 15 minutes without visitors, and the first visit afterwards takes
about a minute to wake it. The free plan also has no persistent disk, so accounts, ratings and game history are wiped
whenever the service restarts or redeploys. To keep data, upgrade the service and attach a disk mounted at `/data`,
then set `DB_FILE=/data/chess.db`.

**Other hosts**: Railway, Fly.io or any VPS work the same way (Docker or `npm ci && npm start`).
Serve it over HTTPS, set `TRUST_PROXY=1`, keep `DB_FILE` on persistent storage, and make sure WebSockets are allowed.

## How it's built

```
server/
  index.js      entry point
  app.js        Express HTTP API, static files, security headers, PGN export
  hub.js        Socket.IO hub: lobby, seeks, quick pairing, challenges, rematches, ratings on game end
  game.js       one live game: rules (chess.js), clocks, offers, presence; transport-agnostic
  glicko2.js    Glicko-2 rating system
  db.js         SQLite schema + queries (users, sessions, ratings, games)
  auth.js       password hashing, cookies, guest identities
  timecontrol.js
public/         no-build vanilla JS front end (ES modules)
  js/board.js   the interactive chessboard component
  js/pages/     lobby, game, profile, leaderboard, auth, create-game dialog
test/           node:test suites (game engine, ratings, full server over real sockets)
```

Notes and limits:
- Games in progress live in server memory. If the server restarts, ongoing games are lost; finished games are stored in SQLite.
  One process handles a lot of concurrent games, but scaling to several processes would need shared state (e.g. Redis).
- Piece artwork is by Colin M.L. Burnett, CC BY-SA 3.0 (see `public/assets/PIECES-LICENSE.txt`).
