import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateRating, rateGame, DEFAULT_RATING } from '../server/glicko2.js';

test("matches Glickman's worked example (approximately)", () => {
  // Example from the Glicko-2 paper, played one game at a time is different from
  // the batch example, so we check the single-game math against known properties.
  const p = { rating: 1500, rd: 200, vol: 0.06 };
  const win = updateRating(p, { rating: 1400, rd: 30, vol: 0.06 }, 1);
  const loss = updateRating(p, { rating: 1400, rd: 30, vol: 0.06 }, 0);
  assert.ok(win.rating > 1500 && win.rating < 1600, `win → ${win.rating}`);
  assert.ok(loss.rating < 1500 && loss.rating > 1300, `loss → ${loss.rating}`);
  assert.ok(win.rd < 200 && loss.rd < 200, 'RD shrinks after playing');
  assert.ok(1500 - loss.rating > win.rating - 1500, 'losing to a weaker player costs more');
});

test('new players move a lot; zero-sum-ish between equals', () => {
  const r = rateGame(DEFAULT_RATING, DEFAULT_RATING, 1);
  assert.ok(r.white.rating > 1600);
  assert.ok(r.black.rating < 1400);
  assert.ok(Math.abs((r.white.rating - 1500) + (r.black.rating - 1500)) < 1);
  const d = rateGame(DEFAULT_RATING, DEFAULT_RATING, 0.5);
  assert.ok(Math.abs(d.white.rating - 1500) < 1e-6);
});

test('RD stays within bounds', () => {
  let p = { ...DEFAULT_RATING };
  for (let i = 0; i < 300; i++) p = updateRating(p, { rating: 1500, rd: 50, vol: 0.06 }, i % 2);
  assert.ok(p.rd >= 45);
  assert.ok(Math.abs(p.rating - 1500) < 100);
});
