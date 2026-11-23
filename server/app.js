// HTTP server: static client, JSON API, Socket.IO hub.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openDatabase } from './db.js';
import { Hub, archivedState } from './hub.js';
import {
  hashPassword,
  verifyPassword,
  validateCredentials,
  parseCookies,
  resolveIdentity,
  isValidGuestId,
  newGuestId,
  guestName,
} from './auth.js';
import { CATEGORIES } from './timecontrol.js';
import { PROVISIONAL_RD } from './glicko2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const YEAR = 365 * 24 * 3600 * 1000;

export function createApp({
  dbFile = path.join(ROOT, 'data', 'chess.db'),
  firstMoveMs,
  claimMs,
  trustProxy = false,
} = {}) {
  const db = openDatabase(dbFile);
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  const server = http.createServer(app);

  const io = new SocketServer(server, {
    serveClient: true,
    // Reject cross-site WebSocket connections.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);
      try {
        cb(null, new URL(origin).host === req.headers.host);
      } catch {
        cb(null, false);
      }
    },
  });
  const hub = new Hub({ io, db, firstMoveMs, claimMs });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });

  // Identity: every visitor gets a guest id cookie; signed-in users also have a session cookie.
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    if (!isValidGuestId(req.cookies.gid)) {
      req.cookies.gid = newGuestId();
      setCookie(req, res, 'gid', req.cookies.gid, YEAR);
    }
    req.identity = resolveIdentity(db, req.cookies);
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // ---- static -------------------------------------------------------------
  app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));
  app.get('/vendor/chess.js', (req, res) =>
    res.sendFile(path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'), { maxAge: '1d' }),
  );

  // ---- auth ---------------------------------------------------------------
  const attempts = new Map();
  const limited = (req) => {
    const now = Date.now();
    const key = req.ip;
    const list = (attempts.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    attempts.set(key, list);
    if (attempts.size > 10_000) attempts.clear();
    return list.length > 10;
  };

  app.get('/api/me', (req, res) => {
    const id = req.identity;
    if (id?.registered) {
      return res.json({ user: { username: id.name, ratings: ratingsOf(db, id.userId) } });
    }
    res.json({ user: null, guestName: guestName(req.cookies.gid) });
  });

  app.post('/api/register', async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many attempts, try again in a minute.' });
    const { username, password } = req.body ?? {};
    const problem = validateCredentials(username, password);
    if (problem) return res.status(400).json({ error: problem });
    if (db.userByName(username)) return res.status(409).json({ error: 'That username is taken.' });
    const hash = await hashPassword(password);
    let userId;
    try {
      userId = db.createUser(username, hash);
    } catch {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    setCookie(req, res, 'sid', db.createSession(userId), 30 * 24 * 3600 * 1000);
    res.json({ ok: true, username });
  });

  app.post('/api/login', async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many attempts, try again in a minute.' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Enter a username and password.' });
    }
    const user = db.userByName(username);
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
    setCookie(req, res, 'sid', db.createSession(user.id), 30 * 24 * 3600 * 1000);
    res.json({ ok: true, username: user.username });
  });

  app.post('/api/logout', (req, res) => {
    if (req.cookies.sid) db.deleteSession(req.cookies.sid);
    setCookie(req, res, 'sid', '', 0);
    res.json({ ok: true });
  });

  // ---- data ---------------------------------------------------------------
  app.get('/api/users/:name', (req, res) => {
    const user = db.userByName(req.params.name);
    if (!user) return res.status(404).json({ error: 'No such player' });
    res.json({
      username: user.username,
      createdAt: user.created_at,
      ratings: ratingsOf(db, user.id),
      stats: db.userStats(user.id),
      playing: hub.activeGameOf(`u:${user.id}`),
      online: hub.connections.has(`u:${user.id}`),
    });
  });

  app.get('/api/users/:name/games', (req, res) => {
    const user = db.userByName(req.params.name);
    if (!user) return res.status(404).json({ error: 'No such player' });
    const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
    const size = 20;
    const rows = db.userGames(user.id, size + 1, page * size);
    res.json({ games: rows.slice(0, size).map(gameListItem), more: rows.length > size });
  });

  app.get('/api/leaderboard', (req, res) => {
    const out = {};
    for (const c of CATEGORIES) {
      out[c] = db.leaderboard(c, 50).map((r) => ({
        username: r.username,
        rating: Math.round(r.rating),
        provisional: r.rd > PROVISIONAL_RD,
        games: r.games,
      }));
    }
    res.json(out);
  });

  app.get('/api/recent', (req, res) => {
    res.json({ games: db.recentGames(10).map(gameListItem), counts: db.counts() });
  });

  app.get('/api/games/:id/pgn', (req, res) => {
    const live = hub.games.get(req.params.id);
    let state;
    if (live) state = { ...live.state(), endedAt: live.endedAt };
    else {
      const row = db.gameById(req.params.id);
      if (!row) return res.status(404).type('text').send('Game not found');
      state = archivedState(row);
    }
    res.type('application/x-chess-pgn');
    res.setHeader('Content-Disposition', `attachment; filename="game-${state.id}.pgn"`);
    res.send(toPgn(state, `${req.protocol}://${req.get('host')}`));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // SPA fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC, 'index.html'));
  });

  return {
    app,
    server,
    io,
    hub,
    db,
    async close() {
      hub.close();
      await io.close();
      db.close();
    },
  };
}

function setCookie(req, res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function ratingsOf(db, userId) {
  const stored = db.allRatings(userId);
  const out = {};
  for (const c of CATEGORIES) {
    const r = stored[c];
    out[c] = r
      ? { rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games, provisional: r.rd > PROVISIONAL_RD }
      : { rating: 1500, rd: 350, games: 0, provisional: true };
  }
  return out;
}

function gameListItem(row) {
  return {
    id: row.id,
    white: { name: row.white_name, registered: row.white_id != null, rating: row.white_rating, ratingDiff: row.white_diff },
    black: { name: row.black_name, registered: row.black_id != null, rating: row.black_rating, ratingDiff: row.black_diff },
    rated: Boolean(row.rated),
    minutes: row.minutes,
    increment: row.increment,
    category: row.category,
    status: row.status,
    winner: row.winner,
    plies: row.moves ? row.moves.split(' ').length : 0,
    fen: row.final_fen,
    endedAt: row.ended_at,
  };
}

const TERMINATION = {
  mate: 'Normal',
  resign: 'Normal',
  stalemate: 'Normal',
  insufficient: 'Normal',
  repetition: 'Normal',
  fiftymoves: 'Normal',
  agreement: 'Normal',
  outoftime: 'Time forfeit',
  abandoned: 'Abandoned',
  aborted: 'Unterminated',
};

export function toPgn(state, site) {
  const result = state.status !== 'ended' || state.result?.reason === 'aborted'
    ? '*'
    : state.result.winner === 'w' ? '1-0' : state.result.winner === 'b' ? '0-1' : '1/2-1/2';
  const date = new Date(state.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cat = state.category[0].toUpperCase() + state.category.slice(1);
  const headers = [
    ['Event', `${state.rated ? 'Rated' : 'Casual'} ${cat} game`],
    ['Site', `${site}/game/${state.id}`],
    ['Date', `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`],
    ['White', state.white.name],
    ['Black', state.black.name],
    ['Result', result],
  ];
  if (state.white.rating != null) headers.push(['WhiteElo', String(state.white.rating)]);
  if (state.black.rating != null) headers.push(['BlackElo', String(state.black.rating)]);
  if (state.white.ratingDiff != null) headers.push(['WhiteRatingDiff', signed(state.white.ratingDiff)]);
  if (state.black.ratingDiff != null) headers.push(['BlackRatingDiff', signed(state.black.ratingDiff)]);
  headers.push(['TimeControl', `${Math.round(state.minutes * 60)}+${state.increment}`]);
  headers.push(['Termination', state.status === 'ended' ? TERMINATION[state.result.reason] ?? 'Normal' : 'Unterminated']);

  let body = '';
  state.san.forEach((san, i) => {
    if (i % 2 === 0) body += `${i / 2 + 1}. `;
    body += `${san} `;
  });
  body += result;
  const wrapped = body.replace(/(.{1,79})(\s|$)/g, '$1\n').trim();
  return `${headers.map(([k, v]) => `[${k} "${esc(v)}"]`).join('\n')}\n\n${wrapped}\n`;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}
