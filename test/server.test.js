import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../server/app.js';

let ctx;
let base;

before(async () => {
  ctx = createApp({ dbFile: ':memory:' });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  ctx.server.close();
  await ctx.close();
});

async function http(path, body, cookie) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, cookies: setCookies };
}

/** Register a user (or create a guest when name is null) and open a socket. */
async function client(name) {
  const first = await http('/api/me');
  let cookie = first.cookies.join('; ');
  if (name) {
    const r = await http('/api/register', { username: name, password: 'secret123' }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    cookie = [cookie, ...r.cookies].join('; ');
  }
  const socket = connect(base, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
  await new Promise((r) => socket.on('connect', r));
  const emit = (event, payload = {}) => new Promise((r) => socket.emit(event, payload, r));
  const next = (event, pred = () => true) =>
    new Promise((resolve) => {
      const h = (data) => {
        if (pred(data)) {
          socket.off(event, h);
          resolve(data);
        }
      };
      socket.on(event, h);
    });
  return { socket, emit, next, cookie };
}

test('registration validation and login', async () => {
  const bad = await http('/api/register', { username: 'x', password: 'secret123' });
  assert.equal(bad.status, 400);
  const ok = await http('/api/register', { username: 'zoe', password: 'secret123' });
  assert.equal(ok.status, 200);
  const dup = await http('/api/register', { username: 'ZOE', password: 'secret123' });
  assert.equal(dup.status, 409);
  const wrong = await http('/api/login', { username: 'zoe', password: 'nope' });
  assert.equal(wrong.status, 401);
  const login = await http('/api/login', { username: 'zoe', password: 'secret123' });
  assert.equal(login.status, 200);
  const me = await http('/api/me', null, login.cookies.join('; '));
  assert.equal(me.data.user.username, 'zoe');
  assert.equal(me.data.user.ratings.blitz.rating, 1500);
});

test('rated quick pairing, full game, ratings and PGN', async () => {
  const alice = await client('alice');
  const bob = await client('bob');

  const startA = alice.next('game:start');
  const startB = bob.next('game:start');
  const r1 = await alice.emit('quickpair', { minutes: 3, increment: 2, rated: true });
  assert.ok(r1.seekId, JSON.stringify(r1));
  const r2 = await bob.emit('quickpair', { minutes: 3, increment: 2, rated: true });
  assert.ok(r2.gameId, JSON.stringify(r2));
  const { id } = await startA;
  assert.equal((await startB).id, id);

  const ja = await alice.emit('game:join', { id });
  const jb = await bob.emit('game:join', { id });
  assert.equal(ja.kind, 'live');
  assert.notEqual(ja.you, jb.you);
  assert.equal(ja.state.category, 'blitz');
  assert.equal(JSON.stringify(ja).includes('u:'), false, 'internal keys must not leak');

  const white = ja.you === 'w' ? alice : bob;
  const black = ja.you === 'w' ? bob : alice;

  // A spectator (guest) can watch but not move.
  const guest = await client(null);
  const js = await guest.emit('game:join', { id });
  assert.equal(js.you, null);
  assert.ok((await guest.emit('game:move', { id, from: 'e2', to: 'e4' })).error);

  const moves = [[white, 'f2', 'f3'], [black, 'e7', 'e5'], [white, 'g2', 'g4'], [black, 'd8', 'h4']];
  const ended = guest.next('game:state', (s) => s.status === 'ended');
  for (const [who, from, to] of moves) {
    const seen = guest.next('game:move');
    const r = await who.emit('game:move', { id, from, to });
    assert.ok(r.ok, JSON.stringify(r));
    await seen;
  }
  const final = await ended;
  assert.equal(final.result.reason, 'mate');
  assert.equal(final.result.winner, 'b');
  assert.ok(final.black.ratingDiff > 0);
  assert.ok(final.white.ratingDiff < 0);

  // Chat
  const chatSeen = black.next('game:chat');
  await white.emit('game:chat', { id, text: 'gg <b>wp</b>' });
  assert.equal((await chatSeen).msg.text, 'gg <b>wp</b>');

  // Persisted + rating change visible via the API.
  const blackName = ja.you === 'w' ? 'bob' : 'alice';
  const prof = await http(`/api/users/${blackName}`);
  assert.ok(prof.data.ratings.blitz.rating > 1500);
  assert.equal(prof.data.stats.wins, 1);
  const games = await http(`/api/users/${blackName}/games`);
  assert.equal(games.data.games[0].id, id);
  const lb = await http('/api/leaderboard');
  assert.equal(lb.data.blitz[0].username, blackName);

  const pgn = await http(`/api/games/${id}/pgn`);
  assert.match(pgn.data, /\[Result "0-1"\]/);
  assert.match(pgn.data, /1\. f3 e5 2\. g4 Qh4# 0-1/);
  assert.match(pgn.data, /\[TimeControl "180\+2"\]/);

  // Rematch: both agree → new game with colors swapped.
  const restart = white.next('game:start');
  await white.emit('game:rematch', { id });
  await black.emit('game:rematch', { id });
  const { id: id2 } = await restart;
  assert.notEqual(id2, id);
  const j2 = await white.emit('game:join', { id: id2 });
  assert.equal(j2.you, 'b');

  for (const c of [alice, bob, guest]) c.socket.close();
});

test('guests cannot play rated; friend challenge by link', async () => {
  const guest = await client(null);
  const carol = await client('carol');
  assert.equal((await guest.emit('seek:create', { minutes: 5, increment: 0, rated: true })).error, 'Sign in to play rated games');
  assert.equal((await guest.emit('seek:create', { minutes: 7.5, increment: 0 })).error, 'Invalid time control');

  const ch = await carol.emit('challenge:create', { minutes: 10, increment: 0, rated: false, color: 'white' });
  assert.ok(ch.id);
  const view = await guest.emit('game:join', { id: ch.id });
  assert.equal(view.kind, 'challenge');
  assert.equal(view.challenge.challenger.name, 'carol');
  assert.equal(view.challenge.mine, false);
  const started = carol.next('game:start');
  const acc = await guest.emit('challenge:accept', { id: ch.id });
  assert.equal(acc.gameId, ch.id);
  await started;
  const j = await carol.emit('game:join', { id: ch.id });
  assert.equal(j.you, 'w');
  assert.equal(j.state.rated, false);

  // Abort before moves.
  const r = await carol.emit('game:abort', { id: ch.id });
  assert.ok(r.ok);
  carol.socket.close();
  guest.socket.close();
});

test('lobby lists seeks without leaking owner identity', async () => {
  const dave = await client('dave');
  const eve = await client(null);
  await eve.emit('lobby:join');
  const seen = eve.next('lobby:seeks', (list) => list.length > 0);
  await dave.emit('seek:create', { minutes: 10, increment: 5, rated: false, color: 'black' });
  const list = await seen;
  assert.equal(list[0].player.name, 'dave');
  assert.equal(list[0].mine, false);
  assert.equal(JSON.stringify(list).includes('u:'), false);
  // Owner disconnecting removes the seek.
  const gone = eve.next('lobby:seeks', (l) => l.length === 0);
  dave.socket.close();
  await gone;
  eve.socket.close();
});

test('SPA fallback and security headers', async () => {
  const res = await fetch(`${base}/game/abc`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<main id="app"/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const api404 = await fetch(`${base}/api/nope`);
  assert.equal(api404.status, 404);
});
