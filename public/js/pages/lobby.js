// Lobby: quick pairing, open seeks, live games, game creation.
import { h, clear, api, toast, tcLabel, capitalize, storage, playerLink, describeResult, timeAgo } from '../util.js';
import { Board } from '../board.js';
import { openGameDialog } from './create.js';

const QUICK = [
  [1, 0], [2, 1], [3, 0],
  [3, 2], [5, 0], [5, 3],
  [10, 0], [10, 5], [15, 10],
  [30, 0], [30, 20],
];

const category = (m, i) => {
  const e = m * 60 + 40 * i;
  return e < 180 ? 'bullet' : e < 480 ? 'blitz' : e < 1500 ? 'rapid' : 'classical';
};

export function mount(root, params, ctx) {
  const { socket } = ctx;
  let seeks = [];
  let games = [];
  let pending = null; // { minutes, increment, seekId }
  let tab = storage.get('lobbyTab', 'quick');
  const miniBoards = new Map();

  const tabsEl = h('div.tabs', { role: 'tablist' });
  const body = h('div.tab-body');
  const statsEl = h('div.stats');
  const resumeEl = h('div');
  const recentEl = h('div.recent');
  const ratedToggle = h('input', { type: 'checkbox', id: 'qp-rated', checked: Boolean(ctx.me) && storage.get('qpRated', true), disabled: !ctx.me });

  ratedToggle.addEventListener('change', () => {
    storage.set('qpRated', ratedToggle.checked);
    cancelPending();
  });

  root.append(
    h('div.lobby',
      h('section.lobby-main', tabsEl, body),
      h('aside.lobby-side',
        resumeEl,
        h('div.card.actions',
          h('button.btn.big', { type: 'button', on: { click: () => openGameDialog(ctx, 'seek') } }, 'Create a game'),
          h('button.btn.big.secondary', { type: 'button', on: { click: () => openGameDialog(ctx, 'friend') } }, 'Play with a friend')),
        statsEl,
        recentEl)));

  function renderTabs() {
    const t = (key, label) =>
      h('button.tab', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(tab === key),
        class: tab === key ? 'active' : '',
        on: { click: () => { tab = key; storage.set('lobbyTab', key); renderTabs(); renderBody(); } },
      }, label);
    clear(tabsEl,
      t('quick', 'Quick pairing'),
      t('lobby', `Lobby${seeks.length ? ` (${seeks.length})` : ''}`),
      t('live', `Live games${games.length ? ` (${games.length})` : ''}`));
  }

  function renderBody() {
    if (tab !== 'live') {
      for (const b of miniBoards.values()) b.board.destroy();
      miniBoards.clear();
    }
    if (tab === 'quick') renderQuick();
    else if (tab === 'lobby') renderSeeks();
    else renderLive();
  }

  function renderQuick() {
    const tiles = QUICK.map(([m, i]) => {
      const active = pending && pending.minutes === m && pending.increment === i;
      return h('button.tile', {
        type: 'button',
        class: active ? 'searching' : '',
        'aria-pressed': String(Boolean(active)),
        on: { click: () => quickPair(m, i) },
      },
      h('span.tile-tc', tcLabel(m, i)),
      h('span.tile-cat', active ? h('span.spinner-text', 'Searching…') : capitalize(category(m, i))));
    });
    tiles.push(h('button.tile.custom', { type: 'button', on: { click: () => openGameDialog(ctx, 'seek') } },
      h('span.tile-tc', 'Custom'), h('span.tile-cat', 'Your settings')));
    clear(body,
      h('div.qp-head',
        h('label.toggle', { title: ctx.me ? '' : 'Sign in to play rated games' }, ratedToggle, h('span.slider'), h('span', 'Rated')),
        !ctx.me ? h('span.muted', h('a', { href: '/login' }, 'Sign in'), ' to play rated games') : null),
      h('div.tiles', tiles));
  }

  function renderSeeks() {
    if (!seeks.length) {
      clear(body, h('div.empty', h('p', 'No open games right now.'), h('button.btn', { type: 'button', on: { click: () => openGameDialog(ctx, 'seek') } }, 'Create a game')));
      return;
    }
    const rows = seeks.map((s) =>
      h('tr', {
        class: s.mine ? 'mine' : '',
        tabIndex: 0,
        title: s.mine ? 'Click to cancel your seek' : 'Click to play',
        on: {
          click: () => (s.mine ? cancelSeek(s.id) : acceptSeek(s.id)),
          keydown: (e) => e.key === 'Enter' && (s.mine ? cancelSeek(s.id) : acceptSeek(s.id)),
        },
      },
      h('td', h('span.color-icon', { class: `c-${s.color}`, title: `Seeker plays ${s.color}` })),
      h('td', s.player.name),
      h('td', s.player.rating != null ? `${s.player.rating}${s.player.provisional ? '?' : ''}` : '—'),
      h('td', tcLabel(s.minutes, s.increment)),
      h('td', s.rated ? 'Rated' : 'Casual'),
      h('td.muted', capitalize(s.category)),
      h('td', s.mine ? h('span.badge', 'Yours · cancel') : h('span.badge.go', 'Play'))));
    clear(body, h('table.seeks',
      h('thead', h('tr', h('th', ''), h('th', 'Player'), h('th', 'Rating'), h('th', 'Time'), h('th', 'Mode'), h('th', ''), h('th', ''))),
      h('tbody', rows)));
  }

  function renderLive() {
    if (!games.length) {
      for (const b of miniBoards.values()) b.board.destroy();
      miniBoards.clear();
      clear(body, h('div.empty', h('p', 'No games being played right now. Start one!')));
      return;
    }
    let grid = body.querySelector('.minis');
    if (!grid) {
      grid = h('div.minis');
      clear(body, grid);
    }
    const ids = new Set(games.map((g) => g.id));
    for (const [id, mb] of miniBoards) {
      if (!ids.has(id)) {
        mb.el.remove();
        miniBoards.delete(id);
      }
    }
    for (const g of games) {
      let mb = miniBoards.get(g.id);
      if (!mb) {
        const holder = h('div.mini-board');
        const el = h('a.mini', { href: `/game/${g.id}` },
          h('div.mini-name', playerLink(g.black, { rating: true })),
          holder,
          h('div.mini-name', playerLink(g.white, { rating: true })),
          h('div.mini-tc.muted', `${tcLabel(g.minutes, g.increment)} · ${g.rated ? 'Rated' : 'Casual'}`));
        const board = new Board(holder, { viewOnly: true, coordinates: false });
        mb = { el, board };
        miniBoards.set(g.id, mb);
        grid.appendChild(el);
      }
      const lm = g.lastMove ? [g.lastMove.slice(0, 2), g.lastMove.slice(2, 4)] : null;
      mb.board.set({ fen: g.fen, lastMove: lm });
    }
  }

  function renderStats(s) {
    clear(statsEl,
      h('div.stat', h('strong', String(s.online)), ' players online'),
      h('div.stat', h('strong', String(s.playing)), ' games in play'));
  }

  async function renderRecent() {
    try {
      const data = await api('/api/recent');
      if (!data.games.length) return;
      clear(recentEl,
        h('h3', 'Recently finished'),
        h('ul.recent-list', data.games.map((g) => {
          const r = describeResult({ winner: g.winner, reason: g.status });
          return h('li', h('a', { href: `/game/${g.id}` },
            h('span', `${g.white.name} – ${g.black.name}`),
            h('span.muted', `${r.score} · ${tcLabel(g.minutes, g.increment)} · ${timeAgo(g.endedAt)}`)));
        })));
    } catch {
      /* non-critical */
    }
  }

  // ---- actions --------------------------------------------------------------

  function quickPair(minutes, increment) {
    if (pending && pending.minutes === minutes && pending.increment === increment) {
      cancelPending();
      return;
    }
    cancelPending();
    pending = { minutes, increment, seekId: null };
    renderBody();
    socket.emit('quickpair', { minutes, increment, rated: ratedToggle.checked }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
        pending = null;
        renderBody();
        return;
      }
      if (res.seekId && pending && pending.minutes === minutes && pending.increment === increment) {
        pending.seekId = res.seekId;
      }
    });
  }

  function cancelPending() {
    if (pending?.seekId) socket.emit('seek:cancel', { id: pending.seekId });
    pending = null;
    if (tab === 'quick') renderBody();
  }

  function cancelSeek(id) {
    socket.emit('seek:cancel', { id });
  }

  function acceptSeek(id) {
    socket.emit('seek:accept', { id }, (res) => res?.error && toast(res.error, 'error'));
  }

  // ---- socket ------------------------------------------------------------

  const onSeeks = (list) => {
    seeks = list;
    if (pending?.seekId && !seeks.some((s) => s.id === pending.seekId)) {
      pending = null;
      if (tab === 'quick') renderBody();
    }
    renderTabs();
    if (tab === 'lobby') renderBody();
  };
  const onGames = (list) => {
    games = list;
    renderTabs();
    if (tab === 'live') renderLive();
  };
  const onStats = (s) => renderStats(s);
  const join = () =>
    socket.emit('lobby:join', {}, (res) => {
      if (res?.playing) {
        clear(resumeEl, h('a.card.resume', { href: `/game/${res.playing}` }, h('strong', 'You have a game in progress'), h('span', 'Resume →')));
      } else clear(resumeEl);
    });

  socket.on('lobby:seeks', onSeeks);
  socket.on('lobby:games', onGames);
  socket.on('lobby:stats', onStats);
  socket.on('connect', join);
  const onSeekCreated = () => {
    tab = 'lobby';
    storage.set('lobbyTab', tab);
    renderTabs();
    renderBody();
  };
  window.addEventListener('seek-created', onSeekCreated);
  join();

  renderTabs();
  renderBody();
  renderRecent();

  // "New opponent" from a finished game lands here with ?quick=5+3
  const quick = params.query.get('quick');
  if (quick) {
    const [m, i] = quick.split('+').map(Number);
    history.replaceState(null, '', '/');
    if (params.query.get('rated') === '0') ratedToggle.checked = false;
    tab = 'quick';
    renderTabs();
    quickPair(m, i);
  }

  return () => {
    // Seeks only live while their owner is in the lobby.
    for (const s of seeks) if (s.mine) socket.emit('seek:cancel', { id: s.id });
    socket.emit('lobby:leave');
    socket.off('lobby:seeks', onSeeks);
    socket.off('lobby:games', onGames);
    socket.off('lobby:stats', onStats);
    socket.off('connect', join);
    window.removeEventListener('seek-created', onSeekCreated);
    for (const mb of miniBoards.values()) mb.board.destroy();
  };
}
