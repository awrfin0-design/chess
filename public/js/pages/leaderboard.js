// Leaderboard per time category.
import { h, clear, api, capitalize } from '../util.js';

export function mount(root) {
  const grid = h('div.leaderboard', h('p.muted', 'Loading…'));
  root.append(h('h1.page-title', 'Leaderboard'), grid);
  let disposed = false;
  api('/api/leaderboard').then((data) => {
    if (disposed) return;
    clear(grid, Object.entries(data).map(([cat, rows]) =>
      h('section.card.lb',
        h('h2', capitalize(cat)),
        rows.length
          ? h('ol', rows.map((r) => h('li',
            h('a', { href: `/@/${encodeURIComponent(r.username)}` }, r.username),
            h('span.lb-rating', `${r.rating}${r.provisional ? '?' : ''}`))))
          : h('p.muted', 'No rated games yet.'))));
  }).catch((err) => clear(grid, h('p', err.message)));
  return () => (disposed = true);
}
