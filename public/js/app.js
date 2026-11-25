// App shell: router, session state, navigation bar, settings.
import { h, clear, api, toast, storage } from './util.js';
import { sound } from './sound.js';
import * as lobby from './pages/lobby.js';
import * as game from './pages/game.js';
import * as profile from './pages/profile.js';
import * as leaderboard from './pages/leaderboard.js';
import * as auth from './pages/auth.js';

/* global io */
const socket = io({ transports: ['websocket', 'polling'] });

const ctx = {
  socket,
  sound,
  me: null, // { username, ratings } when signed in
  guestName: null,
  navigate,
  refreshMe,
  /** Reconnect the socket so the server sees new auth cookies. */
  reconnect() {
    socket.disconnect();
    socket.connect();
  },
};

const routes = [
  [/^\/$/, lobby],
  [/^\/game\/([A-Za-z0-9]+)$/, game, ['id']],
  [/^\/@\/([A-Za-z0-9_-]+)$/, profile, ['name']],
  [/^\/leaderboard$/, leaderboard],
  [/^\/login$/, auth, [], { mode: 'login' }],
  [/^\/register$/, auth, [], { mode: 'register' }],
];

const root = document.getElementById('app');
let cleanup = null;

function route() {
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
    cleanup = null;
  }
  clear(root);
  document.title = 'Rookery — Play chess online';
  const path = location.pathname;
  for (const [re, page, names = [], extra = {}] of routes) {
    const m = path.match(re);
    if (!m) continue;
    const params = { ...extra, query: new URLSearchParams(location.search) };
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    cleanup = page.mount(root, params, ctx) ?? null;
    highlightNav();
    return;
  }
  root.append(h('div.card.notfound', h('h1', 'Page not found'), h('p', h('a', { href: '/' }, 'Back to the lobby'))));
}

function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', route);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
  if (a.pathname.startsWith('/api/')) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
});

// A game was created for us (seek accepted, challenge accepted, rematch…).
socket.on('game:start', ({ id }) => {
  sound.notify();
  if (location.pathname !== `/game/${id}`) navigate(`/game/${id}`);
});

socket.on('connect_error', () => setConnection(false));
socket.on('disconnect', () => setConnection(false));
socket.on('connect', () => setConnection(true));

function setConnection(ok) {
  let banner = document.querySelector('.offline');
  if (ok) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = h('div.offline', { role: 'alert' }, 'Reconnecting…');
    document.body.appendChild(banner);
  }
}

// ---- session & nav ------------------------------------------------------

async function refreshMe() {
  try {
    const data = await api('/api/me');
    ctx.me = data.user;
    ctx.guestName = data.guestName ?? null;
  } catch {
    ctx.me = null;
  }
  renderNav();
}

function renderNav() {
  const right = document.getElementById('nav-right');
  const settings = settingsMenu();
  if (ctx.me) {
    const menu = h('div.dropdown',
      h('button.btn-ghost.user-btn', { type: 'button', 'aria-haspopup': 'true', on: { click: (e) => toggleDropdown(e.currentTarget) } },
        h('span.dot.on'), ctx.me.username, ' ▾'),
      h('div.dropdown-menu',
        h('a', { href: `/@/${encodeURIComponent(ctx.me.username)}` }, 'Profile'),
        h('button', { type: 'button', on: { click: logout } }, 'Sign out')));
    clear(right, settings, menu);
  } else {
    clear(right, settings,
      h('a.btn-ghost', { href: '/login' }, 'Sign in'),
      h('a.btn.small', { href: '/register' }, 'Register'));
  }
}

function toggleDropdown(btn) {
  const dd = btn.closest('.dropdown');
  const open = !dd.classList.contains('open');
  document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  dd.classList.toggle('open', open);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
});

function settingsMenu() {
  const option = (key, value, label, apply) =>
    h('button.opt', {
      type: 'button',
      class: storage.get(key, defaults[key]) === value ? 'active' : '',
      on: {
        click: (e) => {
          storage.set(key, value);
          apply(value);
          e.currentTarget.parentElement.querySelectorAll('.opt').forEach((b) => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
        },
      },
    }, label);
  const applyTheme = (t) => {
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  };
  const applyBoard = (b) => (document.documentElement.dataset.board = b);
  return h('div.dropdown.settings',
    h('button.btn-ghost.icon-btn', { type: 'button', title: 'Settings', 'aria-label': 'Settings', on: { click: (e) => toggleDropdown(e.currentTarget) } }, '⚙'),
    h('div.dropdown-menu.wide',
      h('div.menu-label', 'Theme'),
      h('div.opts', option('theme', 'dark', 'Dark', applyTheme), option('theme', 'light', 'Light', applyTheme), option('theme', 'system', 'System', applyTheme)),
      h('div.menu-label', 'Board'),
      h('div.opts',
        ...['green', 'brown', 'blue', 'gray'].map((b) =>
          option('board', b, h('span.swatch', { class: `sw-${b}`, title: b }), applyBoard))),
      h('div.menu-label', 'Sound'),
      h('div.opts', option('sound', true, 'On', () => sound.move()), option('sound', false, 'Off', () => {}))));
}

const defaults = { theme: 'dark', board: 'green', sound: true };

async function logout() {
  await api('/api/logout', {});
  await refreshMe();
  ctx.reconnect();
  toast('Signed out');
  navigate('/');
}

function highlightNav() {
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.pathname === location.pathname);
  });
}

document.documentElement.dataset.booted = '1';
await refreshMe();
route();
