// Real-time layer: lobby seeks, friend challenges, live games, ratings on game end.
import { randomInt } from 'node:crypto';
import { Chess } from 'chess.js';
import { Game, newId, publicPlayer } from './game.js';
import { categoryOf, parseTimeControl } from './timecontrol.js';
import { rateGame, PROVISIONAL_RD } from './glicko2.js';
import { parseCookies, resolveIdentity, newGuestId, guestName } from './auth.js';

const MAX_SEEKS_PER_PLAYER = 3;
const ENDED_GAME_TTL_MS = 20 * 60_000;
const CHALLENGE_TTL_MS = 60 * 60_000;
const CHAT_MAX = 140;

export class Hub {
  constructor({ io, db, firstMoveMs = 30_000, claimMs = 30_000 }) {
    this.io = io;
    this.db = db;
    this.firstMoveMs = firstMoveMs;
    this.claimMs = claimMs;
    /** @type {Map<string, Game>} */
    this.games = new Map();
    this.seeks = new Map();
    this.challenges = new Map();
    this.connections = new Map(); // player key -> socket count
    this.lobbyDirty = true;

    io.use((socket, next) => {
      const cookies = parseCookies(socket.request.headers.cookie);
      let id = resolveIdentity(db, cookies);
      if (!id) {
        const gid = newGuestId();
        id = { key: `g:${gid}`, userId: null, name: guestName(gid), registered: false };
      }
      socket.data.identity = id;
      socket.data.playing = new Map(); // gameId -> color (games this socket counts as present in)
      socket.data.lastChat = 0;
      next();
    });

    io.on('connection', (socket) => this.onConnection(socket));

    this.lobbyInterval = setInterval(() => this.flushLobby(), 1500);
    this.lobbyInterval.unref?.();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref?.();
  }

  close() {
    clearInterval(this.lobbyInterval);
    clearInterval(this.cleanupInterval);
    for (const g of this.games.values()) g.dispose();
  }

  // ---- connection lifecycle ----------------------------------------------

  onConnection(socket) {
    const me = socket.data.identity;
    socket.join(`player:${me.key}`);
    this.connections.set(me.key, (this.connections.get(me.key) ?? 0) + 1);
    this.lobbyDirty = true;

    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const result = handler(payload ?? {});
          reply(result ?? { ok: true });
        } catch (err) {
          console.error(`[${event}]`, err);
          reply({ error: 'Server error' });
        }
      });
    };

    on('lobby:join', () => {
      socket.join('lobby');
      socket.emit('lobby:seeks', this.seekList(me.key));
      socket.emit('lobby:games', this.liveGameList());
      socket.emit('lobby:stats', this.stats());
      return { ok: true, playing: this.activeGameOf(me.key) };
    });
    on('lobby:leave', () => socket.leave('lobby'));

    on('seek:create', (p) => this.createSeek(me, p));
    on('seek:cancel', (p) => this.cancelSeek(me, p.id));
    on('seek:accept', (p) => this.acceptSeek(me, p.id));
    on('quickpair', (p) => this.quickPair(me, p));

    on('challenge:create', (p) => this.createChallenge(me, p));
    on('challenge:cancel', (p) => this.cancelChallenge(me, p.id));
    on('challenge:accept', (p) => this.acceptChallenge(me, p.id));

    on('game:join', (p) => this.joinGame(socket, String(p.id ?? '')));
    on('game:leave', (p) => this.leaveGame(socket, String(p.id ?? '')));

    const action = (event, fn) =>
      on(event, (p) => {
        const game = this.games.get(String(p.id ?? ''));
        if (!game) return { error: 'Game not found' };
        const color = game.colorOf(me.key);
        if (!color) return { error: 'You are not playing in this game' };
        return fn(game, color, p);
      });

    action('game:move', (g, c, p) => {
      const r = g.move(c, p);
      return r.error ? { error: r.error, state: g.state() } : { ok: true };
    });
    action('game:resign', (g, c) => g.resign(c));
    action('game:abort', (g, c) => g.abort(c));
    action('game:draw', (g, c) => g.offerDraw(c));
    action('game:draw-decline', (g, c) => g.declineDraw(c));
    action('game:takeback', (g, c) => g.offerTakeback(c));
    action('game:takeback-decline', (g, c) => g.declineTakeback(c));
    action('game:claim-victory', (g, c) => g.claimVictory(c));
    action('game:claim-draw', (g, c) => g.claimDraw(c));
    action('game:rematch', (g, c) => {
      const r = g.offerRematch(c);
      if (r.accepted) this.createRematch(g);
      return r;
    });
    action('game:rematch-decline', (g, c) => g.declineRematch(c));

    on('game:chat', (p) => {
      const game = this.games.get(String(p.id ?? ''));
      if (!game) return { error: 'Game not found' };
      const text = String(p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!text) return { error: 'Empty message' };
      const now = Date.now();
      if (now - socket.data.lastChat < 700) return { error: 'Slow down' };
      socket.data.lastChat = now;
      const color = game.colorOf(me.key);
      game.addChat(me.name, text, color ?? 'spectator');
      return { ok: true };
    });

    socket.on('disconnect', () => {
      for (const [gameId, color] of socket.data.playing) {
        this.games.get(gameId)?.disconnect(color);
      }
      socket.data.playing.clear();
      const n = (this.connections.get(me.key) ?? 1) - 1;
      if (n <= 0) {
        this.connections.delete(me.key);
        // Seeks vanish when their owner is gone.
        for (const [id, s] of this.seeks) if (s.key === me.key) this.seeks.delete(id);
      } else {
        this.connections.set(me.key, n);
      }
      this.lobbyDirty = true;
    });
  }

  // ---- players --------------------------------------------------------------

  makePlayer(identity, category) {
    if (identity.userId == null) {
      return { key: identity.key, userId: null, name: identity.name, rating: null, provisional: false };
    }
    const r = this.db.getRating(identity.userId, category);
    return {
      key: identity.key,
      userId: identity.userId,
      name: identity.name,
      rating: r.rating,
      provisional: r.rd > PROVISIONAL_RD,
    };
  }

  activeGameOf(key) {
    for (const g of this.games.values()) if (!g.ended && g.colorOf(key)) return g.id;
    return null;
  }

  // ---- seeks ------------------------------------------------------------------

  parseGameOptions(identity, p) {
    const tc = parseTimeControl(p);
    if (!tc) return { error: 'Invalid time control' };
    const rated = Boolean(p.rated);
    if (rated && !identity.registered) return { error: 'Sign in to play rated games' };
    const color = ['white', 'black', 'random'].includes(p.color) ? p.color : 'random';
    return { ...tc, rated, color, category: categoryOf(tc.minutes, tc.increment) };
  }

  createSeek(me, p) {
    const opts = this.parseGameOptions(me, p);
    if (opts.error) return opts;
    const mine = [...this.seeks.values()].filter((s) => s.key === me.key);
    if (mine.length >= MAX_SEEKS_PER_PLAYER) return { error: `You can have at most ${MAX_SEEKS_PER_PLAYER} open seeks` };
    const player = this.makePlayer(me, opts.category);
    const seek = { id: newId(6), key: me.key, identity: me, player, ...opts, createdAt: Date.now() };
    this.seeks.set(seek.id, seek);
    this.lobbyDirty = true;
    this.flushLobby();
    return { ok: true, id: seek.id };
  }

  cancelSeek(me, id) {
    const s = this.seeks.get(id);
    if (!s || s.key !== me.key) return { error: 'Seek not found' };
    this.seeks.delete(id);
    this.lobbyDirty = true;
    this.flushLobby();
    return { ok: true };
  }

  acceptSeek(me, id) {
    const s = this.seeks.get(id);
    if (!s) return { error: 'That seek is no longer available' };
    if (s.key === me.key) return { error: 'You cannot accept your own seek' };
    if (s.rated && !me.registered) return { error: 'Sign in to play rated games' };
    this.seeks.delete(id);
    // Both players' other seeks are withdrawn once they start playing.
    for (const [sid, other] of this.seeks) if (other.key === me.key || other.key === s.key) this.seeks.delete(sid);
    this.lobbyDirty = true;
    const game = this.startGame(s.identity, me, s);
    return { ok: true, gameId: game.id };
  }

  quickPair(me, p) {
    const opts = this.parseGameOptions(me, { ...p, color: 'random' });
    if (opts.error) return opts;
    let best = null;
    for (const s of this.seeks.values()) {
      if (s.key === me.key || s.color !== 'random') continue;
      if (s.minutes !== opts.minutes || s.increment !== opts.increment || s.rated !== opts.rated) continue;
      if (!best || s.createdAt < best.createdAt) best = s;
    }
    if (best) return this.acceptSeek(me, best.id);
    // Don't create a duplicate of an identical seek we already have.
    for (const s of this.seeks.values()) {
      if (s.key === me.key && s.minutes === opts.minutes && s.increment === opts.increment && s.rated === opts.rated) {
        return { ok: true, seekId: s.id };
      }
    }
    const r = this.createSeek(me, opts);
    return r.error ? r : { ok: true, seekId: r.id };
  }

  // ---- challenges (play a friend by link) -----------------------------------

  createChallenge(me, p) {
    const opts = this.parseGameOptions(me, p);
    if (opts.error) return opts;
    const id = this.uniqueGameId();
    const challenge = { id, key: me.key, identity: me, ...opts, createdAt: Date.now() };
    this.challenges.set(id, challenge);
    return { ok: true, id };
  }

  cancelChallenge(me, id) {
    const c = this.challenges.get(id);
    if (!c || c.key !== me.key) return { error: 'Challenge not found' };
    this.challenges.delete(id);
    this.io.to(`game:${id}`).emit('challenge:canceled', { id });
    return { ok: true };
  }

  acceptChallenge(me, id) {
    const c = this.challenges.get(id);
    if (!c) return { error: 'Challenge not found' };
    if (c.key === me.key) return { error: 'You cannot accept your own challenge' };
    if (c.rated && !me.registered) return { error: 'Sign in to accept a rated challenge' };
    this.challenges.delete(id);
    const game = this.startGame(c.identity, me, c, id);
    return { ok: true, gameId: game.id };
  }

  challengeView(c, me) {
    return {
      id: c.id,
      challenger: publicPlayer(this.makePlayer(c.identity, c.category)),
      minutes: c.minutes,
      increment: c.increment,
      rated: c.rated,
      category: c.category,
      color: c.color,
      mine: c.key === me.key,
    };
  }

  // ---- games --------------------------------------------------------------

  uniqueGameId() {
    let id;
    do id = newId(8);
    while (this.games.has(id) || this.challenges.has(id) || this.db.gameById(id));
    return id;
  }

  /** owner created the seek/challenge with options; opp accepted. */
  startGame(ownerIdentity, oppIdentity, opts, id = this.uniqueGameId()) {
    let ownerWhite;
    if (opts.color === 'white') ownerWhite = true;
    else if (opts.color === 'black') ownerWhite = false;
    else ownerWhite = randomInt(2) === 0;
    const owner = this.makePlayer(ownerIdentity, opts.category);
    const opp = this.makePlayer(oppIdentity, opts.category);
    return this.launch({
      id,
      white: ownerWhite ? owner : opp,
      black: ownerWhite ? opp : owner,
      minutes: opts.minutes,
      increment: opts.increment,
      rated: opts.rated,
    });
  }

  launch({ id, white, black, minutes, increment, rated }) {
    const game = new Game({
      id,
      white,
      black,
      minutes,
      increment,
      rated,
      firstMoveMs: this.firstMoveMs,
      claimMs: this.claimMs,
    });
    this.games.set(id, game);
    const room = `game:${id}`;
    game.on('move', (m) => {
      this.io.to(room).emit('game:move', { id, ...m });
      this.lobbyDirty = true; // keeps lobby mini-boards fresh
    });
    game.on('update', () => this.io.to(room).emit('game:state', game.state()));
    game.on('takeback', () => this.io.to(room).emit('game:state', game.state()));
    game.on('chat', (msg) => this.io.to(room).emit('game:chat', { id, msg }));
    game.on('end', () => this.onGameEnd(game));
    this.lobbyDirty = true;
    for (const p of [white, black]) this.io.to(`player:${p.key}`).emit('game:start', { id });
    return game;
  }

  createRematch(old) {
    const swap = (p) => this.makePlayer({ key: p.key, userId: p.userId, name: p.name }, old.category);
    const game = this.launch({
      id: this.uniqueGameId(),
      white: swap(old.players.b),
      black: swap(old.players.w),
      minutes: old.minutes,
      increment: old.increment,
      rated: old.rated,
    });
    old.rematchId = game.id;
    this.io.to(`game:${old.id}`).emit('game:state', old.state());
  }

  onGameEnd(game) {
    const { winner, reason } = game.result;
    const w = game.players.w;
    const b = game.players.b;
    const rated = game.rated && reason !== 'aborted' && w.userId != null && b.userId != null;
    try {
      this.db.transaction(() => {
        if (rated) {
          const rw = this.db.getRating(w.userId, game.category);
          const rb = this.db.getRating(b.userId, game.category);
          const score = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
          const next = rateGame(rw, rb, score);
          this.db.setRating(w.userId, game.category, next.white);
          this.db.setRating(b.userId, game.category, next.black);
          game.ratingDiff.w = Math.round(next.white.rating) - Math.round(rw.rating);
          game.ratingDiff.b = Math.round(next.black.rating) - Math.round(rb.rating);
        }
        this.db.saveGame({
          id: game.id,
          whiteId: w.userId,
          blackId: b.userId,
          whiteName: w.name,
          blackName: b.name,
          whiteRating: w.rating == null ? null : Math.round(w.rating),
          blackRating: b.rating == null ? null : Math.round(b.rating),
          whiteDiff: game.ratingDiff.w,
          blackDiff: game.ratingDiff.b,
          rated: game.rated,
          minutes: game.minutes,
          increment: game.increment,
          category: game.category,
          moves: game.uci.join(' '),
          status: reason,
          winner,
          finalFen: game.chess.fen(),
          createdAt: game.createdAt,
          endedAt: game.endedAt,
        });
      });
    } catch (err) {
      console.error('Failed to save game', game.id, err);
    }
    this.io.to(`game:${game.id}`).emit('game:state', game.state());
    this.lobbyDirty = true;
  }

  joinGame(socket, id) {
    const me = socket.data.identity;
    const room = `game:${id}`;
    const game = this.games.get(id);
    if (game) {
      socket.join(room);
      const color = game.colorOf(me.key);
      if (color && !game.ended && !socket.data.playing.has(id)) {
        socket.data.playing.set(id, color);
        game.connect(color);
      }
      return { kind: 'live', state: game.state(), you: color, chat: game.chat };
    }
    const challenge = this.challenges.get(id);
    if (challenge) {
      socket.join(room);
      return { kind: 'challenge', challenge: this.challengeView(challenge, me) };
    }
    const row = this.db.gameById(id);
    if (row) {
      const you = row.white_id != null && me.userId === row.white_id ? 'w' : row.black_id != null && me.userId === row.black_id ? 'b' : null;
      return { kind: 'archived', state: archivedState(row), you, chat: [] };
    }
    return { error: 'Game not found' };
  }

  leaveGame(socket, id) {
    socket.leave(`game:${id}`);
    const color = socket.data.playing.get(id);
    if (color) {
      socket.data.playing.delete(id);
      this.games.get(id)?.disconnect(color);
    }
    return { ok: true };
  }

  // ---- lobby broadcast -----------------------------------------------------

  seekList(viewerKey) {
    return [...this.seeks.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s.id,
        player: publicPlayer(s.player),
        minutes: s.minutes,
        increment: s.increment,
        rated: s.rated,
        color: s.color,
        category: s.category,
        mine: s.key === viewerKey,
      }));
  }

  liveGameList() {
    return [...this.games.values()]
      .filter((g) => !g.ended)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 24)
      .map((g) => g.summary());
  }

  stats() {
    let playing = 0;
    for (const g of this.games.values()) if (!g.ended) playing++;
    return { online: this.connections.size, playing };
  }

  flushLobby() {
    if (!this.lobbyDirty) return;
    this.lobbyDirty = false;
    const room = this.io.sockets.adapter.rooms.get('lobby');
    if (!room) return;
    const games = this.liveGameList();
    const stats = this.stats();
    for (const sid of room) {
      const s = this.io.sockets.sockets.get(sid);
      if (!s) continue;
      s.emit('lobby:seeks', this.seekList(s.data.identity.key));
      s.emit('lobby:games', games);
      s.emit('lobby:stats', stats);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [id, g] of this.games) {
      if (g.ended && now - g.endedAt > ENDED_GAME_TTL_MS) {
        g.dispose();
        this.games.delete(id);
      }
    }
    for (const [id, c] of this.challenges) {
      if (now - c.createdAt > CHALLENGE_TTL_MS) this.challenges.delete(id);
    }
    this.db.purgeSessions();
  }
}

/** Build a client state object for a finished game loaded from the database. */
export function archivedState(row) {
  const uci = row.moves ? row.moves.split(' ') : [];
  const chess = new Chess();
  const san = [];
  for (const m of uci) {
    const mv = chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    san.push(mv.san);
  }
  const player = (name, userId, rating, diff) => ({
    name,
    registered: userId != null,
    rating,
    provisional: false,
    ratingDiff: diff,
  });
  return {
    id: row.id,
    live: false,
    white: player(row.white_name, row.white_id, row.white_rating, row.white_diff),
    black: player(row.black_name, row.black_id, row.black_rating, row.black_diff),
    minutes: row.minutes,
    increment: row.increment,
    rated: Boolean(row.rated),
    category: row.category,
    uci,
    san,
    fen: row.final_fen,
    status: 'ended',
    result: { winner: row.winner, reason: row.status },
    clock: null,
    running: false,
    firstMoveMsLeft: null,
    firstMoveMs: 0,
    offers: { draw: null, takeback: null, rematch: { w: false, b: false } },
    online: { w: false, b: false },
    goneMs: { w: null, b: null },
    claimMs: 0,
    rematchId: null,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

