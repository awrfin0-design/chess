// Glicko-2 rating system (Glickman, 2012). Each game is treated as its own
// rating period, which is what most online chess servers do.

const SCALE = 173.7178;
const TAU = 0.75;
const EPSILON = 0.000001;

export const DEFAULT_RATING = Object.freeze({ rating: 1500, rd: 350, vol: 0.06 });
export const MIN_RD = 45;
export const MAX_RD = 350;
export const PROVISIONAL_RD = 110;

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * Update a player's rating after a single game.
 * @param {{rating:number, rd:number, vol:number}} player
 * @param {{rating:number, rd:number, vol:number}} opponent
 * @param {number} score 1 = win, 0.5 = draw, 0 = loss
 */
export function updateRating(player, opponent, score) {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  const muJ = (opponent.rating - 1500) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const eJ = E(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * eJ * (1 - eJ));
  const delta = v * gJ * (score - eJ);

  // Step 5: new volatility via the Illinois algorithm.
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > EPSILON && iterations++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gJ * (score - eJ);

  const rating = Math.max(400, Math.min(4000, newMu * SCALE + 1500));
  const rd = Math.max(MIN_RD, Math.min(MAX_RD, newPhi * SCALE));
  return { rating, rd, vol: Math.min(newSigma, 0.1) };
}

/** Update both players at once. scoreWhite: 1, 0.5 or 0. */
export function rateGame(white, black, scoreWhite) {
  return {
    white: updateRating(white, black, scoreWhite),
    black: updateRating(black, white, 1 - scoreWhite),
  };
}
