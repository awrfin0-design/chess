import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, hasMatingMaterial } from '../server/game.js';
import { Chess } from 'chess.js';

const player = (key, name) => ({ key, userId: null, name, rating: null, provisional: false });

function makeGame(opts = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const game = new Game({
    white: player('W', 'Alice'),
    black: player('B', 'Bob'),
    minutes: 1,
    increment: 2,
    rated: false,
    now: clock.now,
    ...opts,
  });
  return { game, clock };
}

const play = (game, ...moves) => {
  for (const m of moves) {
    const color = game.turn();
    const r = game.move(color, { from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    assert.ok(r.ok, `move ${m} failed: ${r.error}`);
  }
};

test('rejects moves out of turn and illegal moves', () => {
  const { game } = makeGame();
  assert.equal(game.move('b', { from: 'e7', to: 'e5' }).error, 'Not your turn');
  assert.equal(game.move('w', { from: 'e2', to: 'e5' }).error, 'Illegal move');
  assert.equal(game.move('w', { from: 'z9', to: 'e4' }).error, 'Bad square');
  assert.ok(game.move('w', { from: 'e2', to: 'e4' }).ok);
  game.dispose();
});

test("fool's mate ends the game with checkmate", () => {
  const { game } = makeGame();
  let ended = null;
  game.on('end', (r) => (ended = r));
  play(game, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(game.status, 'ended');
  assert.deepEqual(ended, { winner: 'b', reason: 'mate', by: null });
  assert.deepEqual(game.san, ['f3', 'e5', 'g4', 'Qh4#']);
  game.dispose();
});

test('clocks start after both first moves and add increment', () => {
  const { game, clock } = makeGame();
  clock.advance(5000);
  play(game, 'e2e4');
  assert.equal(game.clock.w, 60_000, 'no time used before clocks start');
  clock.advance(5000);
  play(game, 'e7e5');
  assert.equal(game.clock.b, 60_000);
  assert.equal(game.clocksRunning(), true);
  clock.advance(3000);
  play(game, 'g1f3');
  assert.equal(game.clock.w, 60_000 - 3000 + 2000);
  clock.advance(1000);
  assert.equal(game.remaining('b'), 59_000);
  game.dispose();
});

test('flag fall: opponent wins, or draw without mating material', () => {
  const { game, clock } = makeGame();
  play(game, 'e2e4', 'e7e5');
  clock.advance(61_000);
  game.tick();
  assert.deepEqual(game.result, { winner: 'b', reason: 'outoftime', by: null });
  assert.equal(game.clock.w, 0);
  game.dispose();

  const lone = new Chess('8/8/8/4k3/8/8/8/4K2N w - - 0 1');
  assert.equal(hasMatingMaterial(lone, 'w'), false);
  assert.equal(hasMatingMaterial(new Chess(), 'b'), true);
});

test('moving after the flag fell is refused', () => {
  const { game, clock } = makeGame();
  play(game, 'e2e4', 'e7e5');
  clock.advance(70_000);
  const r = game.move('w', { from: 'g1', to: 'f3' });
  assert.ok(r.error);
  assert.equal(game.result.reason, 'outoftime');
  game.dispose();
});

test('first move timeout aborts the game', () => {
  const { game, clock } = makeGame({ firstMoveMs: 10_000 });
  clock.advance(10_001);
  game.tick();
  assert.equal(game.result.reason, 'aborted');
  game.dispose();
});

test('abort only allowed before both sides moved; resign before that aborts', () => {
  const { game } = makeGame();
  play(game, 'e2e4');
  assert.ok(game.resign('b').ok);
  assert.equal(game.result.reason, 'aborted');
  game.dispose();

  const g2 = makeGame().game;
  play(g2, 'e2e4', 'e7e5');
  assert.equal(g2.abort('w').error, 'Too late to abort');
  assert.ok(g2.resign('w').ok);
  assert.deepEqual(g2.result, { winner: 'b', reason: 'resign', by: null });
  g2.dispose();
});

test('draw offers: accept, decline, and implicit decline by moving', () => {
  const { game } = makeGame();
  play(game, 'e2e4', 'e7e5');
  assert.ok(game.offerDraw('w').ok);
  assert.equal(game.offers.draw, 'w');
  play(game, 'g1f3'); // white's own offer survives white's move
  assert.equal(game.offers.draw, 'w');
  play(game, 'b8c6'); // black moving declines it
  assert.equal(game.offers.draw, null);
  game.offerDraw('b');
  assert.ok(game.declineDraw('w').ok);
  assert.equal(game.offers.draw, null);
  game.offerDraw('b');
  const r = game.offerDraw('w');
  assert.equal(r.accepted, true);
  assert.deepEqual(game.result, { winner: null, reason: 'agreement', by: null });
  game.dispose();
});

test('takeback undoes the right number of plies', () => {
  const { game } = makeGame();
  play(game, 'e2e4', 'e7e5', 'g1f3');
  // Black proposes after white replied: undo 1 ply? No — it's black's turn, proposer is black,
  // so black's last move (e5) and white's reply (Nf3) are both undone.
  assert.ok(game.offerTakeback('b').ok);
  assert.ok(game.acceptTakeback('w').ok);
  assert.deepEqual(game.san, ['e4']);
  assert.equal(game.turn(), 'b');
  // White proposes on black's turn: only white's last move is undone.
  assert.ok(game.offerTakeback('w').ok);
  assert.ok(game.offerTakeback('b').accepted);
  assert.deepEqual(game.san, []);
  game.dispose();
});

test('threefold repetition draws automatically', () => {
  const { game } = makeGame();
  play(game, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.deepEqual(game.result, { winner: null, reason: 'repetition', by: null });
  game.dispose();
});

test('promotion requires a valid piece and is recorded in UCI', () => {
  const { game } = makeGame();
  play(game, 'a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2');
  assert.equal(game.move('w', { from: 'b7', to: 'a8', promotion: 'k' }).error, 'Bad promotion');
  play(game, 'b7a8n');
  assert.equal(game.uci.at(-1), 'b7a8n');
  assert.equal(game.san.at(-1), 'bxa8=N');
  game.dispose();
});

test('abandonment claims require the opponent to be gone long enough', () => {
  const { game, clock } = makeGame({ claimMs: 15_000 });
  game.connect('w');
  game.connect('b');
  play(game, 'e2e4', 'e7e5');
  game.disconnect('b');
  assert.equal(game.claimVictory('w').error, 'Cannot claim yet');
  clock.advance(15_000);
  assert.ok(game.claimVictory('w').ok);
  assert.deepEqual(game.result, { winner: 'w', reason: 'abandoned', by: null });
  game.dispose();
});

test('rematch needs both players', () => {
  const { game } = makeGame();
  play(game, 'e2e4', 'e7e5');
  assert.ok(game.offerRematch('w').error, 'not allowed mid-game');
  game.resign('b');
  assert.equal(game.offerRematch('w').accepted, undefined);
  assert.equal(game.offerRematch('b').accepted, true);
  game.dispose();
});
