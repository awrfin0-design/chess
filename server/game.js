// A single live game: rules (via chess.js), clocks, offers and presence.
// The class is transport-agnostic; it emits events that the socket layer relays.
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { Chess } from 'chess.js';
import { categoryOf } from './timecontrol.js';

export const opposite = (c) => (c === 'w' ? 'b' : 'w');

const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newId(length = 8) {
  let s = '';
  for (let i = 0; i < length; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

const PROMOTIONS = new Set(['q', 'r', 'b', 'n']);
const SQUARE = /^[a-h][1-8]$/;

/**
 * Can `color` possibly deliver checkmate with its remaining material?
 * Used when a player runs out of time: if the opponent cannot mate, it's a draw.
 */
export function hasMatingMaterial(chess, color) {
  let minors = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== color) continue;
      if (p.type === 'p' || p.type === 'r' || p.type === 'q') return true;
      if (p.type === 'n' || p.type === 'b') minors++;
    }
  }
  return minors >= 2;
}

export class Game extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{key:string,userId:number|null,name:string,rating:number|null,provisional:boolean}} opts.white
   * @param {typeof opts.white} opts.black
   */
  constructor({
    id = newId(),
    white,
    black,
    minutes,
    increment,
    rated,
    now = Date.now,
    firstMoveMs = 30_000,
    claimMs = 30_000,
  }) {
    super();
    this.id = id;
    this.players = { w: white, b: black };
    this.minutes = minutes;
    this.increment = increment;
    this.rated = Boolean(rated);
    this.category = categoryOf(minutes, increment);
    this.now = now;
    this.firstMoveMs = firstMoveMs;
    this.claimMs = claimMs;

    this.chess = new Chess();
    this.uci = [];
    this.san = [];
    this.clock = { w: minutes * 60_000, b: minutes * 60_000 };
    this.createdAt = now();
    this.turnStartedAt = this.createdAt;
    this.status = 'started';
    this.result = null; // { winner: 'w'|'b'|null, reason }
    this.endedAt = null;
    this.offers = { draw: null, takeback: null, rematch: { w: false, b: false } };
    this.online = { w: 0, b: 0 };
    this.goneSince = { w: null, b: null };
    this.chat = [];
    this.ratingDiff = { w: null, b: null };
    this.rematchId = null;
    this.timer = null;
    this.schedule();
  }

  get ended() {
    return this.status === 'ended';
  }

  get incrementMs() {
    return this.increment * 1000;
  }

  colorOf(playerKey) {
    if (this.players.w.key === playerKey) return 'w';
    if (this.players.b.key === playerKey) return 'b';
    return null;
  }

  turn() {
    return this.chess.turn();
  }

  /** Clocks only run once both sides have made their first move. */
  clocksRunning() {
    return !this.ended && this.uci.length >= 2;
  }

  remaining(color, at = this.now()) {
    if (this.clocksRunning() && this.turn() === color) {
      return this.clock[color] - (at - this.turnStartedAt);
    }
    return this.clock[color];
  }

  firstMoveDeadline() {
    if (this.ended || this.uci.length >= 2) return null;
    return this.turnStartedAt + this.firstMoveMs;
  }

  // ---- timers -------------------------------------------------------------

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ended) return;
    const now = this.now();
    let at;
    if (this.uci.length < 2) at = this.firstMoveDeadline();
    else at = now + this.remaining(this.turn(), now);
    this.timer = setTimeout(() => this.tick(), Math.max(0, at - now) + 5);
    this.timer.unref?.();
  }

  /** Check for flag fall / first-move abort. Safe to call at any time. */
  tick() {
    if (this.ended) return;
    const now = this.now();
    if (this.uci.length < 2) {
      if (now >= this.firstMoveDeadline()) this.end(null, 'aborted');
      else this.schedule();
      return;
    }
    const color = this.turn();
    if (this.remaining(color, now) <= 0) {
      const opp = opposite(color);
      this.end(hasMatingMaterial(this.chess, opp) ? opp : null, 'outoftime');
    } else {
      this.schedule();
    }
  }

  // ---- actions ------------------------------------------------------------

  move(color, input) {
    if (this.ended) return { error: 'Game is over' };
    if (this.turn() !== color) return { error: 'Not your turn' };
    const from = String(input?.from ?? '');
    const to = String(input?.to ?? '');
    const promotion = input?.promotion ? String(input.promotion) : undefined;
    if (!SQUARE.test(from) || !SQUARE.test(to)) return { error: 'Bad square' };
    if (promotion && !PROMOTIONS.has(promotion)) return { error: 'Bad promotion' };

    const now = this.now();
    const running = this.clocksRunning();
    const left = running ? this.remaining(color, now) : null; // must be read before the turn flips
    if (running && left <= 0) {
      this.tick();
      return { error: 'Out of time' };
    }

    let mv;
    try {
      mv = this.chess.move({ from, to, promotion });
    } catch {
      return { error: 'Illegal move' };
    }

    if (running) this.clock[color] = left + this.incrementMs;
    this.turnStartedAt = now;
    this.uci.push(mv.from + mv.to + (mv.promotion ?? ''));
    this.san.push(mv.san);

    // A move declines any pending offer made by the opponent, and withdraws stale takebacks.
    if (this.offers.draw === opposite(color)) this.offers.draw = null;
    this.offers.takeback = null;

    const payload = {
      uci: this.uci.at(-1),
      san: mv.san,
      ply: this.uci.length,
      fen: this.chess.fen(),
      clock: { w: this.clock.w, b: this.clock.b },
      running: this.clocksRunning(),
    };
    this.emit('move', payload);

    const c = this.chess;
    if (c.isCheckmate()) this.end(color, 'mate');
    else if (c.isStalemate()) this.end(null, 'stalemate');
    else if (c.isInsufficientMaterial()) this.end(null, 'insufficient');
    else if (c.isThreefoldRepetition()) this.end(null, 'repetition');
    else if (c.isDrawByFiftyMoves()) this.end(null, 'fiftymoves');
    else this.schedule();

    return { ok: true, move: payload };
  }

  abort(color) {
    if (this.ended) return { error: 'Game is over' };
    if (this.uci.length >= 2) return { error: 'Too late to abort' };
    this.end(null, 'aborted', color);
    return { ok: true };
  }

  resign(color) {
    if (this.ended) return { error: 'Game is over' };
    if (this.uci.length < 2) return this.abort(color);
    this.end(opposite(color), 'resign');
    return { ok: true };
  }

  offerDraw(color) {
    if (this.ended) return { error: 'Game is over' };
    if (this.uci.length < 2) return { error: 'Too early to offer a draw' };
    if (this.offers.draw === opposite(color)) {
      this.end(null, 'agreement');
      return { ok: true, accepted: true };
    }
    this.offers.draw = color;
    this.emit('update');
    return { ok: true };
  }

  declineDraw(color) {
    if (this.offers.draw !== opposite(color)) return { error: 'No draw offer' };
    this.offers.draw = null;
    this.emit('update');
    return { ok: true };
  }

  offerTakeback(color) {
    if (this.ended) return { error: 'Game is over' };
    if (this.offers.takeback === opposite(color)) return this.acceptTakeback(color);
    const hasMoved = this.uci.length >= (color === 'w' ? 1 : 2);
    if (!hasMoved) return { error: 'Nothing to take back' };
    this.offers.takeback = color;
    this.emit('update');
    return { ok: true };
  }

  acceptTakeback(color) {
    const proposer = opposite(color);
    if (this.offers.takeback !== proposer) return { error: 'No takeback offer' };
    const now = this.now();
    // Charge the side to move for the time already spent on this turn.
    if (this.clocksRunning()) this.clock[this.turn()] = Math.max(0, this.remaining(this.turn(), now));
    const plies = this.turn() === proposer ? 2 : 1;
    for (let i = 0; i < plies && this.uci.length; i++) {
      this.chess.undo();
      this.uci.pop();
      this.san.pop();
    }
    this.offers.takeback = null;
    this.offers.draw = null;
    this.turnStartedAt = now;
    this.schedule();
    this.emit('takeback');
    return { ok: true, accepted: true };
  }

  declineTakeback(color) {
    if (this.offers.takeback !== opposite(color)) return { error: 'No takeback offer' };
    this.offers.takeback = null;
    this.emit('update');
    return { ok: true };
  }

  offerRematch(color) {
    if (!this.ended) return { error: 'Game is still in progress' };
    if (this.rematchId) return { error: 'Rematch already created' };
    this.offers.rematch[color] = true;
    if (this.offers.rematch[opposite(color)]) return { ok: true, accepted: true };
    this.emit('update');
    return { ok: true };
  }

  declineRematch(color) {
    if (!this.offers.rematch[opposite(color)] && !this.offers.rematch[color]) return { error: 'No rematch offer' };
    this.offers.rematch = { w: false, b: false };
    this.emit('update');
    return { ok: true };
  }

  // ---- presence -----------------------------------------------------------

  connect(color) {
    this.online[color]++;
    if (this.ended) return;
    if (this.goneSince[color] !== null) {
      this.goneSince[color] = null;
      this.emit('update');
    } else if (this.online[color] === 1) {
      this.emit('update');
    }
  }

  disconnect(color) {
    this.online[color] = Math.max(0, this.online[color] - 1);
    if (this.online[color] === 0 && !this.ended) {
      this.goneSince[color] = this.now();
      this.emit('update');
    }
  }

  canClaim(color) {
    const opp = opposite(color);
    return (
      !this.ended &&
      this.uci.length >= 2 &&
      this.goneSince[opp] !== null &&
      this.now() - this.goneSince[opp] >= this.claimMs
    );
  }

  claimVictory(color) {
    if (!this.canClaim(color)) return { error: 'Cannot claim yet' };
    this.end(color, 'abandoned');
    return { ok: true };
  }

  claimDraw(color) {
    if (!this.canClaim(color)) return { error: 'Cannot claim yet' };
    this.end(null, 'abandoned');
    return { ok: true };
  }

  addChat(name, text, role) {
    const msg = { name, text, role, at: this.now() };
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.shift();
    this.emit('chat', msg);
    return msg;
  }

  // ---- ending -------------------------------------------------------------

  end(winner, reason, by = null) {
    if (this.ended) return;
    const now = this.now();
    if (this.clocksRunning()) {
      const c = this.turn();
      this.clock[c] = Math.max(0, this.remaining(c, now));
    }
    this.status = 'ended';
    this.result = { winner, reason, by };
    this.endedAt = now;
    this.offers.draw = null;
    this.offers.takeback = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.emit('end', this.result);
  }

  /** Full state for clients. */
  state() {
    const now = this.now();
    const deadline = this.firstMoveDeadline();
    const gone = (c) => (this.goneSince[c] === null ? null : now - this.goneSince[c]);
    return {
      id: this.id,
      live: true,
      white: this.players.w && publicPlayer(this.players.w, this.ratingDiff.w),
      black: this.players.b && publicPlayer(this.players.b, this.ratingDiff.b),
      minutes: this.minutes,
      increment: this.increment,
      rated: this.rated,
      category: this.category,
      uci: this.uci,
      san: this.san,
      fen: this.chess.fen(),
      status: this.status,
      result: this.result,
      clock: { w: Math.max(0, this.remaining('w', now)), b: Math.max(0, this.remaining('b', now)) },
      running: this.clocksRunning(),
      firstMoveMsLeft: deadline === null ? null : Math.max(0, deadline - now),
      firstMoveMs: this.firstMoveMs,
      offers: this.offers,
      online: { w: this.online.w > 0, b: this.online.b > 0 },
      goneMs: { w: gone('w'), b: gone('b') },
      claimMs: this.claimMs,
      rematchId: this.rematchId,
      createdAt: this.createdAt,
    };
  }

  /** Compact summary for lobby "live games" lists. */
  summary() {
    return {
      id: this.id,
      white: publicPlayer(this.players.w),
      black: publicPlayer(this.players.b),
      minutes: this.minutes,
      increment: this.increment,
      rated: this.rated,
      category: this.category,
      fen: this.chess.fen(),
      lastMove: this.uci.at(-1) ?? null,
      ply: this.uci.length,
    };
  }

  dispose() {
    clearTimeout(this.timer);
    this.removeAllListeners();
  }
}

export function publicPlayer(p, ratingDiff = null) {
  return {
    name: p.name,
    registered: p.userId != null,
    rating: p.rating == null ? null : Math.round(p.rating),
    provisional: Boolean(p.provisional),
    ratingDiff,
  };
}
