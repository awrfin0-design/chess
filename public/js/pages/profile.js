// Player profile: ratings, record and game history.
import { h, clear, api, capitalize, tcLabel, describeResult, ratingDiffEl, timeAgo } from '../util.js';
import { Board } from '../board.js';

const CATS = ['bullet', 'blitz', 'rapid', 'classical'];

export function mount(root, { name }, ctx) {
  let disposed = false;
  let page = 0;
  const boards = [];
  const head = h('div.card.profile-head', h('p.muted', 'Loading…'));
  const ratingsEl = h('div.rating-cards');
  const gamesEl = h('div.game-list');
  const moreEl = h('div.center');
  root.append(h('div.profile', head, ratingsEl, h('h2.section-title', 'Games'), gamesEl, moreEl));

  (async () => {
    let user;
    try {
      user = await api(`/api/users/${encodeURIComponent(name)}`);
    } catch (err) {
      clear(head, h('h1', 'Player not found'), h('p.muted', err.message));
      return;
    }
    if (disposed) return;
    document.title = `${user.username} · Rookery`;
    const s = user.stats;
    const isMe = ctx.me?.username === user.username;
    clear(head,
      h('div.ph-title',
        h('span.dot', { class: user.online ? 'on' : 'off', title: user.online ? 'Online' : 'Offline' }),
        h('h1', user.username),
        isMe ? h('span.badge', 'You') : null),
      h('p.muted', `Member since ${new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`),
      user.playing ? h('p', h('a.btn.small', { href: `/game/${user.playing}` }, '▶ Watch current game')) : null,
      h('div.record',
        h('div', h('strong', String(s.total)), h('span', 'games')),
        h('div.win', h('strong', String(s.wins)), h('span', 'wins')),
        h('div.loss', h('strong', String(s.losses)), h('span', 'losses')),
        h('div.draw', h('strong', String(s.draws)), h('span', 'draws'))));
    clear(ratingsEl, CATS.map((c) => {
      const r = user.ratings[c];
      return h('div.card.rating-card',
        h('div.rc-cat', capitalize(c)),
        h('div.rc-rating', `${r.rating}${r.provisional ? '?' : ''}`),
        h('div.rc-games.muted', `${r.games} rated game${r.games === 1 ? '' : 's'}`));
    }));
    loadGames(user.username);
  })();

  async function loadGames(username) {
    const data = await api(`/api/users/${encodeURIComponent(username)}/games?page=${page}`);
    if (disposed) return;
    if (!data.games.length && page === 0) gamesEl.append(h('p.muted.empty', 'No games yet.'));
    for (const g of data.games) {
      const youWhite = g.white.name.toLowerCase() === username.toLowerCase();
      const r = describeResult({ winner: g.winner, reason: g.status });
      const outcome = g.status === 'aborted' ? 'aborted' : !g.winner ? 'draw' : (g.winner === 'w') === youWhite ? 'win' : 'loss';
      const holder = h('div.gl-board');
      const side = (p) => h('div.gl-player', p.registered ? h('a', { href: `/@/${encodeURIComponent(p.name)}` }, p.name) : h('span', p.name),
        p.rating != null ? h('span.muted', ` ${p.rating}`) : null, ratingDiffEl(p.ratingDiff));
      gamesEl.append(h('a.card.gl-item', { href: `/game/${g.id}`, class: outcome },
        holder,
        h('div.gl-body',
          h('div.gl-meta.muted', `${tcLabel(g.minutes, g.increment)} · ${g.rated ? 'Rated' : 'Casual'} ${capitalize(g.category)} · ${timeAgo(g.endedAt)}`),
          h('div.gl-players', side(g.white), h('span.vs', 'vs'), side(g.black)),
          h('div.gl-result', h('span.outcome', capitalize(outcome)), ` ${r.score} · ${r.detail || r.text}`),
          h('div.muted.small', `${Math.ceil(g.plies / 2)} moves`))));
      const b = new Board(holder, { viewOnly: true, coordinates: false, orientation: youWhite ? 'white' : 'black' });
      b.set({ fen: g.fen, animate: false });
      boards.push(b);
    }
    clear(moreEl, data.more ? h('button.btn.secondary', { type: 'button', on: { click: () => { page++; loadGames(username); } } }, 'Load more') : null);
  }

  return () => {
    disposed = true;
    boards.forEach((b) => b.destroy());
  };
}
