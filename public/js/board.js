// Interactive chessboard: click or drag to move, animated transitions,
// legal-move hints, premoves and a promotion picker. No dependencies.

const FILES = 'abcdefgh';
const SPRITE = '/assets/pieces.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function parseFen(fen) {
  const map = new Map();
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        map.set(FILES[f] + (8 - r), color + ch.toLowerCase());
        f++;
      }
    }
  });
  return map;
}

const fileIdx = (sq) => sq.charCodeAt(0) - 97;
const rankIdx = (sq) => Number(sq[1]) - 1;
const sqName = (f, r) => FILES[f] + (r + 1);
const dist = (a, b) => Math.max(Math.abs(fileIdx(a) - fileIdx(b)), Math.abs(rankIdx(a) - rankIdx(b)));

/** Squares a piece could move to on a board, ignoring whose turn it is (for premoves). */
function premoveDests(sq, piece, pieces) {
  const f = fileIdx(sq);
  const r = rankIdx(sq);
  const color = piece[0];
  const type = piece[1];
  const out = [];
  const add = (df, dr) => {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(sqName(nf, nr));
  };
  const ray = (df, dr) => {
    for (let i = 1; i < 8; i++) {
      const nf = f + df * i;
      const nr = r + dr * i;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) break;
      const s = sqName(nf, nr);
      out.push(s);
      // Stop behind our own pieces only beyond the first one (it may move away/be captured).
      const p = pieces.get(s);
      if (p && p[0] === color && p[1] !== 'p') break;
    }
  };
  if (type === 'p') {
    const dir = color === 'w' ? 1 : -1;
    add(0, dir);
    if ((color === 'w' && r === 1) || (color === 'b' && r === 6)) add(0, 2 * dir);
    add(-1, dir);
    add(1, dir);
  } else if (type === 'n') {
    for (const [a, b] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) add(a, b);
  } else if (type === 'k') {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) add(a, b);
    const home = color === 'w' ? 0 : 7;
    if (r === home && f === 4) {
      add(2, 0);
      add(-2, 0);
    }
  } else {
    const dirs = [];
    if (type === 'b' || type === 'q') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
    if (type === 'r' || type === 'q') dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    for (const [a, b] of dirs) ray(a, b);
  }
  return out;
}

export function pieceSvg(code) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${SPRITE}#${code}`);
  svg.appendChild(use);
  return svg;
}

export class Board {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {'white'|'black'} [opts.orientation]
   * @param {boolean} [opts.coordinates]
   * @param {(from:string,to:string,promotion?:string)=>void} [opts.onMove]
   * @param {(from:string,to:string,promotion?:string)=>void} [opts.onPremove]
   * @param {()=>void} [opts.onPremoveCancel]
   */
  constructor(container, opts = {}) {
    this.opts = opts;
    this.orientation = opts.orientation ?? 'white';
    this.pieces = new Map(); // square -> { code, el }
    this.fen = null;
    this.lastMove = null;
    this.check = null;
    this.movable = null; // 'w' | 'b' | null — which color the user may move now
    this.premovable = null; // color allowed to premove
    this.dests = new Map(); // from -> [to]
    this.selected = null;
    this.premove = null; // [from, to]
    this.drag = null;
    this.promoting = null;

    this.el = document.createElement('div');
    this.el.className = 'cb';
    if (opts.coordinates === false) this.el.classList.add('no-coords');
    this.hl = document.createElement('div');
    this.hl.className = 'cb-layer cb-hl';
    this.coords = document.createElement('div');
    this.coords.className = 'cb-layer cb-coords';
    this.layer = document.createElement('div');
    this.layer.className = 'cb-layer cb-pieces';
    this.el.append(this.hl, this.coords, this.layer);
    container.appendChild(this.el);

    if (!opts.viewOnly) {
      this.el.addEventListener('pointerdown', (e) => this.onDown(e));
      this.el.addEventListener('pointermove', (e) => this.onMoveEvt(e));
      this.el.addEventListener('pointerup', (e) => this.onUp(e));
      this.el.addEventListener('pointercancel', () => this.cancelDrag());
      this.el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.unselect();
        this.cancelPremove();
      });
    }
    this.renderCoords();
  }

  destroy() {
    this.el.remove();
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Update any subset of: fen, lastMove ([from,to]|null), check (square|null),
   * movable ('w'|'b'|null), dests (Map), premovable ('w'|'b'|null), animate (bool).
   */
  set(cfg) {
    if ('lastMove' in cfg) this.lastMove = cfg.lastMove;
    if ('check' in cfg) this.check = cfg.check;
    if ('movable' in cfg) this.movable = cfg.movable;
    if ('premovable' in cfg) this.premovable = cfg.premovable;
    if ('dests' in cfg) this.dests = cfg.dests ?? new Map();
    if (cfg.fen && cfg.fen !== this.fen) {
      this.closePromotion();
      this.cancelDrag();
      this.fen = cfg.fen;
      this.syncPieces(parseFen(cfg.fen), cfg.animate !== false);
    }
    if (this.selected) {
      const p = this.pieces.get(this.selected);
      if (!p || !this.canInteract(p.code)) this.selected = null;
    }
    this.renderHighlights();
  }

  setOrientation(o) {
    if (o === this.orientation) return;
    this.orientation = o;
    for (const [sq, p] of this.pieces) this.place(p.el, sq, false);
    this.renderCoords();
    this.renderHighlights();
  }

  flip() {
    this.setOrientation(this.orientation === 'white' ? 'black' : 'white');
  }

  cancelPremove() {
    if (!this.premove) return;
    this.premove = null;
    this.opts.onPremoveCancel?.();
    this.renderHighlights();
  }

  // ---- rendering ----------------------------------------------------------

  pos(sq) {
    const f = fileIdx(sq);
    const r = rankIdx(sq);
    return this.orientation === 'white' ? [f, 7 - r] : [7 - f, r];
  }

  place(el, sq, animate) {
    const [x, y] = this.pos(sq);
    el.classList.toggle('anim', animate);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  makePiece(code) {
    const el = document.createElement('div');
    el.className = `cb-piece p-${code}`;
    el.appendChild(pieceSvg(code));
    return el;
  }

  syncPieces(next, animate) {
    const kept = new Map();
    const orphans = [];
    for (const [sq, p] of this.pieces) {
      if (next.get(sq) === p.code) kept.set(sq, p);
      else orphans.push({ sq, ...p });
    }
    const result = new Map(kept);
    for (const [sq, code] of next) {
      if (kept.has(sq)) continue;
      let best = -1;
      let bestD = Infinity;
      orphans.forEach((o, i) => {
        if (o.code !== code) return;
        const d = dist(o.sq, sq);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      let el;
      if (best >= 0) {
        el = orphans.splice(best, 1)[0].el;
        this.place(el, sq, animate);
      } else {
        el = this.makePiece(code);
        this.place(el, sq, false);
        this.layer.appendChild(el);
      }
      result.set(sq, { code, el });
    }
    for (const o of orphans) o.el.remove();
    this.pieces = result;
  }

  renderCoords() {
    this.coords.textContent = '';
    for (let i = 0; i < 8; i++) {
      const file = document.createElement('span');
      file.className = `cb-file ${i % 2 ? 'on-light' : 'on-dark'}`;
      file.textContent = this.orientation === 'white' ? FILES[i] : FILES[7 - i];
      file.style.left = `${i * 12.5}%`;
      const rank = document.createElement('span');
      rank.className = `cb-rank ${i % 2 ? 'on-dark' : 'on-light'}`;
      rank.textContent = this.orientation === 'white' ? String(8 - i) : String(i + 1);
      rank.style.top = `${i * 12.5}%`;
      this.coords.append(file, rank);
    }
  }

  square(sq, cls) {
    const el = document.createElement('div');
    el.className = `cb-sq ${cls}`;
    const [x, y] = this.pos(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
    this.hl.appendChild(el);
    return el;
  }

  renderHighlights() {
    this.hl.textContent = '';
    if (this.lastMove) for (const sq of this.lastMove) this.square(sq, 'last');
    if (this.premove) for (const sq of this.premove) this.square(sq, 'pre');
    if (this.check) this.square(this.check, 'check');
    if (this.selected) {
      this.square(this.selected, 'sel');
      for (const to of this.targets(this.selected)) {
        this.square(to, this.pieces.has(to) ? 'dest cap' : 'dest');
      }
    }
  }

  // ---- interaction --------------------------------------------------------

  canInteract(code) {
    const c = code[0];
    return c === this.movable || c === this.premovable;
  }

  isPremoveMode(code) {
    return code[0] !== this.movable && code[0] === this.premovable;
  }

  targets(from) {
    const p = this.pieces.get(from);
    if (!p) return [];
    if (this.isPremoveMode(p.code)) return premoveDests(from, p.code, this.pieces);
    return this.dests.get(from) ?? [];
  }

  squareAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === 'white' ? sqName(x, 7 - y) : sqName(7 - x, y);
  }

  select(sq) {
    this.selected = sq;
    this.renderHighlights();
  }

  unselect() {
    if (this.selected) {
      this.selected = null;
      this.renderHighlights();
    }
  }

  onDown(e) {
    if (e.button !== 0 || this.promoting) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq) return;
    const piece = this.pieces.get(sq);

    // Click-to-move onto a target square.
    if (this.selected && this.selected !== sq && this.targets(this.selected).includes(sq)) {
      e.preventDefault();
      this.userMove(this.selected, sq, true);
      return;
    }
    if (piece && this.canInteract(piece.code)) {
      e.preventDefault();
      const wasSelected = this.selected === sq;
      if (!this.isPremoveMode(piece.code)) this.cancelPremove();
      this.select(sq);
      const rect = this.el.getBoundingClientRect();
      this.drag = {
        from: sq,
        el: piece.el,
        startX: e.clientX,
        startY: e.clientY,
        size: rect.width / 8,
        rect,
        started: false,
        wasSelected,
      };
      this.el.setPointerCapture(e.pointerId);
      return;
    }
    this.unselect();
    this.cancelPremove();
  }

  onMoveEvt(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.started = true;
      d.el.classList.add('dragging');
      d.el.classList.remove('anim');
    }
    const x = e.clientX - d.rect.left - d.size / 2;
    const y = e.clientY - d.rect.top - d.size / 2;
    d.el.style.transform = `translate(${x}px, ${y}px)`;
    const over = this.squareAt(e.clientX, e.clientY);
    if (over !== d.over) {
      d.over = over;
      this.hl.querySelector('.hover')?.remove();
      if (over && this.targets(d.from).includes(over)) this.square(over, 'hover');
    }
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.classList.remove('dragging');
    if (!d.started) {
      // Plain click on a piece: second click on the same piece deselects.
      if (d.wasSelected) this.unselect();
      return;
    }
    const to = this.squareAt(e.clientX, e.clientY);
    if (to && to !== d.from && this.targets(d.from).includes(to)) {
      this.userMove(d.from, to, false);
    } else {
      this.place(d.el, d.from, true);
      if (to !== d.from) this.unselect();
      else this.renderHighlights();
    }
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.classList.remove('dragging');
    if (this.pieces.get(d.from)?.el === d.el) this.place(d.el, d.from, false);
  }

  async userMove(from, to, animate) {
    const piece = this.pieces.get(from);
    if (!piece) return;
    const premove = this.isPremoveMode(piece.code);
    this.selected = null;
    const lastRank = piece.code[0] === 'w' ? '8' : '1';
    const isPromotion = piece.code[1] === 'p' && to[1] === lastRank;

    if (premove) {
      this.place(piece.el, from, true);
      this.premove = [from, to];
      this.renderHighlights();
      this.opts.onPremove?.(from, to, isPromotion ? 'q' : undefined);
      return;
    }

    let promotion;
    if (isPromotion) {
      // Show the pawn on the promotion square while choosing.
      this.visualMove(from, to, animate);
      promotion = await this.askPromotion(to, piece.code[0]);
      if (!promotion) {
        // Revert.
        const fen = this.fen;
        this.fen = null;
        this.set({ fen, animate: false });
        return;
      }
    } else {
      this.visualMove(from, to, animate);
    }
    this.lastMove = [from, to];
    this.renderHighlights();
    this.opts.onMove?.(from, to, promotion);
  }

  /** Move a piece element immediately (the authoritative FEN will follow). */
  visualMove(from, to, animate) {
    const p = this.pieces.get(from);
    if (!p) return;
    const captured = this.pieces.get(to);
    if (captured) captured.el.remove();
    this.pieces.delete(from);
    this.pieces.set(to, p);
    this.place(p.el, to, animate);
  }

  askPromotion(sq, color) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cb-promo';
      const [x, y] = this.pos(sq);
      const fromTop = y === 0;
      ['q', 'n', 'r', 'b'].forEach((t, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cb-promo-btn';
        btn.setAttribute('aria-label', { q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[t]);
        btn.style.left = `${x * 12.5}%`;
        btn.style.top = `${(fromTop ? i : 7 - i) * 12.5}%`;
        btn.appendChild(pieceSvg(color + t));
        btn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          finish(t);
        });
        overlay.appendChild(btn);
      });
      overlay.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        finish(null);
      });
      const finish = (choice) => {
        overlay.remove();
        this.promoting = null;
        resolve(choice);
      };
      this.promoting = { overlay, finish };
      this.el.appendChild(overlay);
    });
  }

  closePromotion() {
    this.promoting?.finish(null);
  }
}
