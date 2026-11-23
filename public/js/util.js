// Small DOM + formatting helpers.

/** Create an element: h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const [, tag = 'div', rest = ''] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.textContent = '';
  append(el, children);
  return el;
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function formatMinutes(m) {
  return { 0.25: '¼', 0.5: '½', 0.75: '¾', 1.5: '1½' }[m] ?? String(m);
}

export const tcLabel = (minutes, increment) => `${formatMinutes(minutes)}+${increment}`;

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function formatClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10_000) {
    const s = Math.floor(ms / 1000);
    const tenths = Math.floor((ms % 1000) / 100);
    return `0:0${s}.${tenths}`;
  }
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const units = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [86400 * 30, 'month'],
    [86400 * 365, 'year'],
  ];
  let label = '';
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      label = `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return label;
}

export const REASONS = {
  mate: 'Checkmate',
  resign: (loser) => `${loser} resigned`,
  stalemate: 'Stalemate',
  insufficient: 'Insufficient material',
  repetition: 'Threefold repetition',
  fiftymoves: 'Fifty-move rule',
  agreement: 'Draw by agreement',
  outoftime: (loser) => `${loser} ran out of time`,
  abandoned: (loser) => `${loser} left the game`,
  aborted: 'Game aborted',
};

/** Human-readable result: { score: '1-0', text: 'White wins', detail: 'Checkmate' } */
export function describeResult(result) {
  if (!result) return null;
  const { winner, reason } = result;
  const loser = winner === 'w' ? 'Black' : winner === 'b' ? 'White' : null;
  let detail = REASONS[reason] ?? reason;
  if (typeof detail === 'function') {
    // Draw on time / abandonment has no loser; describe the side that ran out.
    detail = loser ? detail(loser) : reason === 'outoftime' ? 'Time out — insufficient material to win' : 'Opponent left the game';
  }
  if (reason === 'aborted') return { score: '*', text: 'Game aborted', detail: '' };
  if (!winner) return { score: '½-½', text: 'Draw', detail };
  return { score: winner === 'w' ? '1-0' : '0-1', text: `${winner === 'w' ? 'White' : 'Black'} wins`, detail };
}

export function ratingDiffEl(diff) {
  if (diff == null) return null;
  const cls = diff > 0 ? 'good' : diff < 0 ? 'bad' : '';
  return h(`span.rdiff${cls ? '.' + cls : ''}`, diff > 0 ? `+${diff}` : String(diff));
}

export function playerLink(p, { rating = true } = {}) {
  const name = p.registered ? h('a.user-link', { href: `/@/${encodeURIComponent(p.name)}` }, p.name) : h('span.user-link.anon', p.name);
  return h('span.player-label', name, rating && p.rating != null ? h('span.rating', ` ${p.rating}${p.provisional ? '?' : ''}`) : null);
}

export function toast(message, kind = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) box = document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const el = h(`div.toast.${kind}`, message);
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};
