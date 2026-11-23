// Game page: live play, spectating, finished-game replay and friend challenges.
import { Chess } from '/vendor/chess.js';
import { h, clear, toast, tcLabel, capitalize, formatClock, describeResult, ratingDiffEl, playerLink } from '../util.js';
import { Board, parseFen, pieceSvg } from '../board.js';

const opposite = (c) => (c === 'w' ? 'b' : 'w');
const colorName = (c) => (c === 'w' ? 'White' : 'Black');
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function mount(root, { id }, ctx) {
  const { socket, sound } = ctx;

  let state = null;
  let you = null; // 'w' | 'b' | null
  let chess = new Chess();
  let positions = [];
  let viewPly = 0;
  let orientation = 'white';
  let orientationSet = false;
  let premove = null;
  let clockBase = { w: 0, b: 0 };
  let clockAt = performance.now();
  let goneAt = { w: null, b: null };
  let firstMoveLeftAt = null; // { left, at } countdown before the first moves
  let confirmResign = false;
  let lowTimeWarned = false;
  let chat = [];
  let disposed = false;

  // ---- layout ----------------------------------------------------------------
  const infoEl = h('div.card.game-info');
  const chatList = h('div.chat-list', { 'aria-live': 'polite' });
  const chatInput = h('input', { type: 'text', maxLength: 140, placeholder: 'Say something…', 'aria-label': 'Chat message', autocomplete: 'off' });
  const chatEl = h('form.card.chat', { on: { submit: sendChat } }, h('div.chat-title', 'Chat'), chatList, chatInput);
  const boardHolder = h('div.board-holder');
  const topBar = h('div.pbar.top');
  const bottomBar = h('div.pbar.bottom');
  const movesEl = h('div.moves', { role: 'list', 'aria-label': 'Moves' });
  const resultEl = h('div.result');
  const noticeEl = h('div.notices');
  const controlsEl = h('div.controls');
  const navEl = h('div.move-nav');
  const overlayEl = h('div.board-overlay');

  const page = h('div.game-page',
    h('div.game-side', infoEl, chatEl),
    h('div.game-board', h('div.board-wrap', boardHolder, overlayEl)),
    h('div.game-panel',
      topBar,
      h('div.panel-box', navEl, movesEl, resultEl, noticeEl, controlsEl),
      bottomBar));
  root.append(page);
  root.classList.add('wide');

  const board = new Board(boardHolder, {
    onMove: (from, to, promotion) => playMove(from, to, promotion),
    onPremove: (from, to, promotion) => {
      premove = { from, to, promotion };
    },
    onPremoveCancel: () => {
      premove = null;
    },
  });

  // ---- positions ------------------------------------------------------------
  function kingSquare(c, color) {
    return c.findPiece({ type: 'k', color })[0] ?? null;
  }

  function snapshot(c, mv) {
    return {
      fen: c.fen(),
      lastMove: mv ? [mv.from, mv.to] : null,
      check: c.inCheck() ? kingSquare(c, c.turn()) : null,
      san: mv?.san ?? null,
      capture: Boolean(mv?.captured),
    };
  }

  function rebuild() {
    chess = new Chess();
    positions = [snapshot(chess, null)];
    for (const u of state.uci) {
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      positions.push(snapshot(chess, mv));
    }
  }

  const latest = () => positions.length - 1;
  const isLive = () => state?.live && state.status === 'started';
  const running = () => isLive() && state.uci.length >= 2;

  // ---- clocks ---------------------------------------------------------------
  function setClocks(clock) {
    if (!clock) return;
    clockBase = { w: clock.w, b: clock.b };
    clockAt = performance.now();
  }

  function clockValue(c) {
    if (!state?.clock && !state?.live) return null;
    if (running() && chess.turn() === c) return clockBase[c] - (performance.now() - clockAt);
    return clockBase[c];
  }

  // ---- board sync --------------------------------------------------------
  function dests() {
    const map = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!map.has(m.from)) map.set(m.from, []);
      const list = map.get(m.from);
      if (!list.includes(m.to)) list.push(m.to);
    }
    return map;
  }

  function syncBoard(animate = true) {
    const p = positions[viewPly];
    const atLatest = viewPly === latest();
    const playing = isLive() && you && atLatest;
    const myTurn = playing && chess.turn() === you;
    board.set({
      fen: p.fen,
      lastMove: p.lastMove,
      check: p.check,
      movable: myTurn ? you : null,
      dests: myTurn ? dests() : new Map(),
      premovable: playing && !myTurn ? you : null,
      animate,
    });
    if (!playing) board.cancelPremove();
  }

  function playSound(pos) {
    if (!pos?.san) return;
    if (pos.check) sound.check();
    else if (pos.capture) sound.capture();
    else sound.move();
  }

  // ---- making moves ------------------------------------------------------
  function playMove(from, to, promotion) {
    if (!isLive() || !you || chess.turn() !== you) return;
    // Freeze our clock at the moment we move.
    const mine = clockValue(you);
    let mv;
    try {
      mv = chess.move({ from, to, promotion });
    } catch {
      syncBoard(false);
      return;
    }
    if (running()) {
      clockBase[you] = Math.max(0, mine);
    }
    clockAt = performance.now();
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    state.uci.push(uci);
    state.san.push(mv.san);
    positions.push(snapshot(chess, mv));
    viewPly = latest();
    state.offers.takeback = null;
    if (state.offers.draw === opposite(you)) state.offers.draw = null;
    resetFirstMoveCountdown();
    playSound(positions[viewPly]);
    syncBoard(true);
    renderAll();
    socket.emit('game:move', { id, from: mv.from, to: mv.to, promotion: mv.promotion }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
        if (res.state) applyState(res.state);
      }
    });
  }

  function resetFirstMoveCountdown() {
    firstMoveLeftAt = state.uci.length < 2 ? { left: state.firstMoveMs, at: performance.now() } : null;
  }

  function tryPremove() {
    if (!premove) return;
    const pm = premove;
    premove = null;
    board.cancelPremove();
    const legal = chess.moves({ verbose: true }).some((m) => m.from === pm.from && m.to === pm.to);
    if (legal) playMove(pm.from, pm.to, pm.promotion ?? (chess.get(pm.from)?.type === 'p' && /[18]$/.test(pm.to) ? 'q' : undefined));
  }

  // ---- server events ------------------------------------------------------
  function onMove(m) {
    if (m.id !== id || !state || !state.live) return;
    if (m.ply === state.uci.length && state.uci.at(-1) === m.uci) {
      setClocks(m.clock); // echo of our own move
      renderClocks();
      return;
    }
    if (m.ply !== state.uci.length + 1) {
      join();
      return;
    }
    let mv;
    try {
      mv = chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    } catch {
      join();
      return;
    }
    const follow = viewPly === latest();
    state.uci.push(m.uci);
    state.san.push(mv.san);
    positions.push(snapshot(chess, mv));
    // Moving declines a draw offer made to the mover (same rule as the server).
    const mover = opposite(chess.turn());
    if (state.offers.draw === opposite(mover)) state.offers.draw = null;
    state.offers.takeback = null;
    setClocks(m.clock);
    resetFirstMoveCountdown();
    if (follow) {
      viewPly = latest();
      playSound(positions[viewPly]);
    }
    syncBoard(true);
    renderAll();
    if (you && chess.turn() === you) tryPremove();
  }

  function applyState(s, newYou) {
    const prevStatus = state?.status;
    const prevRematch = state?.rematchId ?? null;
    const firstLoad = !state;
    state = s;
    if (newYou !== undefined) you = newYou;
    rebuild();
    viewPly = latest();
    setClocks(s.clock ?? { w: s.minutes * 60_000, b: s.minutes * 60_000 });
    const now = performance.now();
    goneAt = {
      w: s.goneMs?.w == null ? null : now - s.goneMs.w,
      b: s.goneMs?.b == null ? null : now - s.goneMs.b,
    };
    firstMoveLeftAt = s.firstMoveMsLeft == null ? null : { left: s.firstMoveMsLeft, at: now };
    if (!orientationSet) {
      orientation = you === 'b' ? 'black' : 'white';
      board.setOrientation(orientation);
      orientationSet = true;
    }
    if (s.rematchId && !prevRematch && !firstLoad) {
      ctx.navigate(`/game/${s.rematchId}`);
      return;
    }
    if (prevStatus === 'started' && s.status === 'ended') {
      sound.end();
      board.cancelPremove();
    } else if (firstLoad && s.live && s.status === 'started' && s.uci.length === 0) {
      sound.notify();
    }
    syncBoard(!firstLoad);
    renderAll();
  }

  function onState(s) {
    // Ignore broadcasts until our own join reply (which tells us our color) arrived.
    if (s.id !== id || !state) return;
    applyState(s);
  }

  function onChat({ id: gid, msg }) {
    if (gid !== id) return;
    chat.push(msg);
    renderChat();
  }

  function onStart({ id: gid }) {
    if (gid === id) join();
  }

  function onChallengeCanceled({ id: gid }) {
    if (gid !== id) return;
    clear(overlayEl);
    clear(controlsEl);
    clear(noticeEl, h('div.notice', 'This challenge was canceled.'), h('a.btn', { href: '/' }, 'Back to lobby'));
  }

  function join() {
    socket.emit('game:join', { id }, (res) => {
      if (disposed) return;
      if (res?.error) {
        clear(page, h('div.card.notfound', h('h1', 'Game not found'), h('p', 'This game does not exist or has expired.'), h('a.btn', { href: '/' }, 'Back to lobby')));
        return;
      }
      if (res.kind === 'challenge') {
        renderChallenge(res.challenge);
        return;
      }
      clear(overlayEl);
      overlayEl.classList.remove('show');
      chat = res.chat ?? [];
      renderChat();
      applyState(res.state, res.you);
    });
  }

  // ---- rendering ------------------------------------------------------------
  function renderAll() {
    renderInfo();
    renderBars();
    renderMoves();
    renderNav();
    renderResult();
    renderNotices();
    renderControls();
    updateTitle();
  }

  function renderInfo() {
    const s = state;
    const r = s.status === 'ended' ? describeResult(s.result) : null;
    clear(infoEl,
      h('div.gi-head',
        h('div.gi-tc', tcLabel(s.minutes, s.increment)),
        h('div.gi-meta', `${s.rated ? 'Rated' : 'Casual'} · ${capitalize(s.category)}`)),
      h('div.gi-players',
        h('div.gi-player', h('span.color-dot.w'), playerLink(s.white)),
        h('div.gi-player', h('span.color-dot.b'), playerLink(s.black))),
      h('div.gi-status', s.status === 'started' ? (s.live ? h('span.live-dot', 'Playing now') : '') : r ? `${r.text}${r.detail ? ' · ' + r.detail : ''}` : ''),
      s.status === 'ended' ? h('a.btn.small.secondary', { href: `/api/games/${id}/pgn`, download: `game-${id}.pgn` }, 'Download PGN') : null);
  }

  function material(fen) {
    const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const code of parseFen(fen).values()) if (code[1] !== 'k') counts[code[0]][code[1]]++;
    const diff = {};
    let score = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      diff[t] = counts.w[t] - counts.b[t];
      score += diff[t] * VALUES[t];
    }
    return { diff, score };
  }

  function barFor(el, color) {
    const p = color === 'w' ? state.white : state.black;
    const mat = material(positions[viewPly].fen);
    const sign = color === 'w' ? 1 : -1;
    const captured = h('span.captured');
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const n = mat.diff[t] * sign;
      for (let i = 0; i < n; i++) captured.appendChild(h('span.cap', pieceSvg(opposite(color) + t)));
    }
    const adv = mat.score * sign;
    const online = state.live && state.status === 'started' ? h('span.dot', { class: state.online[color] ? 'on' : 'off', title: state.online[color] ? 'Online' : 'Offline' }) : null;
    const clockEl = state.live || state.clock ? h('div.clock', { dataset: { color } }) : null;
    clear(el,
      h('div.pbar-info',
        h('div.pbar-name', online, playerLink(p), state.status === 'ended' ? ratingDiffEl(p.ratingDiff) : null),
        h('div.pbar-mat', captured, adv > 0 ? h('span.adv', `+${adv}`) : null)),
      clockEl);
  }

  function renderBars() {
    const bottom = orientation === 'white' ? 'w' : 'b';
    barFor(bottomBar, bottom);
    barFor(topBar, opposite(bottom));
    renderClocks();
  }

  function renderClocks() {
    for (const el of page.querySelectorAll('.clock')) {
      const c = el.dataset.color;
      const v = clockValue(c);
      if (v == null) continue;
      el.textContent = formatClock(v);
      const ticking = running() && chess.turn() === c;
      el.classList.toggle('running', ticking);
      el.classList.toggle('low', v < Math.min(20_000, state.minutes * 60_000 * 0.1 + 1) && isLive());
      if (ticking && c === you && v < 10_000 && !lowTimeWarned && state.minutes >= 1) {
        lowTimeWarned = true;
        sound.lowTime();
      }
    }
  }

  function renderMoves() {
    const items = [];
    for (let i = 0; i < state.san.length; i += 2) {
      items.push(h('span.mn', `${i / 2 + 1}.`));
      for (const ply of [i + 1, i + 2]) {
        if (ply > state.san.length) {
          items.push(h('span.mv.empty'));
          continue;
        }
        items.push(h('button.mv', {
          type: 'button',
          role: 'listitem',
          class: ply === viewPly ? 'active' : '',
          on: { click: () => goTo(ply) },
        }, state.san[ply - 1]));
      }
    }
    if (!items.length) items.push(h('div.moves-empty.muted', state.live && state.status === 'started' ? 'White to move' : 'No moves'));
    clear(movesEl, items);
    const active = movesEl.querySelector('.mv.active');
    if (active) {
      const top = active.offsetTop - movesEl.offsetTop;
      if (top < movesEl.scrollTop || top > movesEl.scrollTop + movesEl.clientHeight - 30) {
        movesEl.scrollTop = top - movesEl.clientHeight / 2;
      }
    } else if (viewPly === 0) movesEl.scrollTop = 0;
  }

  function renderNav() {
    const btn = (label, title, fn, disabled) =>
      h('button.nav-btn', { type: 'button', title, 'aria-label': title, disabled, on: { click: fn } }, label);
    const end = latest();
    clear(navEl,
      btn('⇅', 'Flip board (f)', flip),
      btn('⏮', 'First move', () => goTo(0), viewPly === 0),
      btn('◀', 'Previous move (←)', () => goTo(viewPly - 1), viewPly === 0),
      btn('▶', 'Next move (→)', () => goTo(viewPly + 1), viewPly === end),
      btn('⏭', 'Last move', () => goTo(end), viewPly === end));
  }

  function renderResult() {
    if (state.status !== 'ended') {
      clear(resultEl);
      return;
    }
    const r = describeResult(state.result);
    clear(resultEl, h('div.result-score', r.score), h('div.result-text', r.text), r.detail ? h('div.result-detail', r.detail) : null);
  }

  function renderNotices() {
    const items = [];
    if (isLive() && you) {
      const opp = opposite(you);
      if (state.offers.draw === opp) {
        items.push(h('div.notice.offer', h('span', 'Your opponent offers a draw'),
          h('div.notice-actions',
            h('button.btn.small', { type: 'button', on: { click: () => act('game:draw') } }, 'Accept'),
            h('button.btn.small.secondary', { type: 'button', on: { click: () => act('game:draw-decline') } }, 'Decline'))));
      }
      if (state.offers.takeback === opp) {
        items.push(h('div.notice.offer', h('span', 'Your opponent proposes a takeback'),
          h('div.notice-actions',
            h('button.btn.small', { type: 'button', on: { click: () => act('game:takeback') } }, 'Accept'),
            h('button.btn.small.secondary', { type: 'button', on: { click: () => act('game:takeback-decline') } }, 'Decline'))));
      }
      if (state.offers.draw === you) items.push(h('div.notice.muted', 'Draw offer sent'));
      if (state.offers.takeback === you) items.push(h('div.notice.muted', 'Takeback proposal sent'));
      if (goneAt[opp] != null && state.uci.length >= 2) {
        const left = Math.ceil((state.claimMs - (performance.now() - goneAt[opp])) / 1000);
        if (left > 0) items.push(h('div.notice.warn', `Your opponent left the game. You can claim victory in ${left}s.`));
        else {
          items.push(h('div.notice.warn', h('span', 'Your opponent left the game.'),
            h('div.notice-actions',
              h('button.btn.small', { type: 'button', on: { click: () => act('game:claim-victory') } }, 'Claim victory'),
              h('button.btn.small.secondary', { type: 'button', on: { click: () => act('game:claim-draw') } }, 'Call it a draw'))));
        }
      }
    }
    if (isLive() && firstMoveLeftAt) {
      const left = Math.max(0, Math.ceil((firstMoveLeftAt.left - (performance.now() - firstMoveLeftAt.at)) / 1000));
      const who = chess.turn();
      const label = you === who ? `You have ${left}s to make your first move` : `${colorName(who)} has ${left}s to make the first move`;
      items.push(h('div.notice.muted.first-move', label));
    }
    if (state.status === 'ended' && you && state.live && !state.rematchId) {
      const opp = opposite(you);
      if (state.offers.rematch[opp] && !state.offers.rematch[you]) {
        items.push(h('div.notice.offer', h('span', 'Your opponent wants a rematch'),
          h('div.notice-actions',
            h('button.btn.small', { type: 'button', on: { click: () => act('game:rematch') } }, 'Accept'),
            h('button.btn.small.secondary', { type: 'button', on: { click: () => act('game:rematch-decline') } }, 'Decline'))));
      }
    }
    if (!you && state.live && state.status === 'started') items.push(h('div.notice.muted', 'You are spectating'));
    clear(noticeEl, items);
  }

  function renderControls() {
    const items = [];
    if (isLive() && you) {
      if (state.uci.length < 2) {
        items.push(h('button.btn.secondary', { type: 'button', on: { click: () => act('game:abort') } }, 'Abort'));
      } else {
        const myMoves = state.uci.length >= (you === 'w' ? 1 : 2);
        items.push(
          h('button.btn.secondary', { type: 'button', title: 'Propose a takeback', disabled: !myMoves || state.offers.takeback === you, on: { click: () => act('game:takeback') } }, '↶ Takeback'),
          h('button.btn.secondary', { type: 'button', title: 'Offer a draw', disabled: state.offers.draw === you, on: { click: () => act('game:draw') } }, '½ Draw'),
          h('button.btn', {
            type: 'button',
            class: confirmResign ? 'danger' : 'secondary',
            on: {
              click: () => {
                if (!confirmResign) {
                  confirmResign = true;
                  renderControls();
                  setTimeout(() => {
                    confirmResign = false;
                    if (!disposed && state) renderControls();
                  }, 3000);
                } else {
                  confirmResign = false;
                  act('game:resign');
                }
              },
            },
          }, confirmResign ? 'Confirm resign?' : '⚑ Resign'));
      }
    } else if (state.status === 'ended') {
      if (you && state.live && !state.rematchId) {
        const sent = state.offers.rematch[you];
        items.push(h('button.btn', { type: 'button', disabled: sent, on: { click: () => act('game:rematch') } }, sent ? 'Rematch offer sent' : 'Rematch'));
      }
      if (state.rematchId) items.push(h('a.btn', { href: `/game/${state.rematchId}` }, 'Go to rematch'));
      items.push(h('a.btn.secondary', { href: `/?quick=${state.minutes}+${state.increment}&rated=${state.rated ? 1 : 0}` }, 'New opponent'));
    }
    clear(controlsEl, items);
  }

  function renderChat() {
    clear(chatList, chat.map((m) =>
      h('div.chat-msg', { class: m.role === 'spectator' ? 'spectator' : '' },
        h('strong', m.name), m.role === 'spectator' ? h('span.muted', ' (spectator)') : null, ': ', m.text)));
    chatList.scrollTop = chatList.scrollHeight;
  }

  function updateTitle() {
    const myTurn = isLive() && you && chess.turn() === you;
    document.title = `${myTurn ? '● Your turn · ' : ''}${state.white.name} vs ${state.black.name} · Rookery`;
  }

  function renderChallenge(c) {
    const url = `${location.origin}/game/${id}`;
    const colorText = c.color === 'random' ? 'random side' : c.mine ? c.color : c.color === 'white' ? 'black' : 'white';
    clear(infoEl,
      h('div.gi-head', h('div.gi-tc', tcLabel(c.minutes, c.increment)), h('div.gi-meta', `${c.rated ? 'Rated' : 'Casual'} · ${capitalize(c.category)}`)),
      h('div.gi-players', h('div.gi-player', playerLink(c.challenger))));
    board.set({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', movable: null, premovable: null });
    let box;
    if (c.mine) {
      const input = h('input.share', { type: 'text', readOnly: true, value: url, 'aria-label': 'Challenge link', on: { focus: (e) => e.target.select() } });
      box = h('div.challenge',
        h('h2', 'Challenge a friend'),
        h('p', 'Send this link to the person you want to play. The first person to open it can join.'),
        h('div.share-row', input,
          h('button.btn', {
            type: 'button',
            on: {
              click: async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast('Link copied');
                } catch {
                  input.select();
                }
              },
            },
          }, 'Copy')),
        h('p.waiting', h('span.spinner'), ' Waiting for your opponent…'),
        h('p.muted.small', `${tcLabel(c.minutes, c.increment)} · ${c.rated ? 'Rated' : 'Casual'} · you play ${colorText}`),
        h('button.btn.secondary', { type: 'button', on: { click: () => socket.emit('challenge:cancel', { id }, () => ctx.navigate('/')) } }, 'Cancel'));
    } else {
      const blocked = c.rated && !ctx.me;
      box = h('div.challenge',
        h('h2', `${c.challenger.name} challenges you`),
        h('p.big-tc', `${tcLabel(c.minutes, c.increment)} · ${c.rated ? 'Rated' : 'Casual'} ${capitalize(c.category)}`),
        h('p', `You play ${colorText}.`),
        blocked
          ? h('p', 'This is a rated game. ', h('a', { href: '/login' }, 'Sign in'), ' or ', h('a', { href: '/register' }, 'register'), ' to accept.')
          : h('button.btn.big', {
            type: 'button',
            on: { click: () => socket.emit('challenge:accept', { id }, (res) => res?.error && toast(res.error, 'error')) },
          }, 'Accept challenge'),
        h('a.btn.secondary', { href: '/' }, 'Decline'));
    }
    clear(overlayEl, box);
    overlayEl.classList.add('show');
    clear(topBar);
    clear(bottomBar);
    clear(movesEl);
    clear(navEl);
  }

  // ---- actions ------------------------------------------------------------
  function act(event) {
    socket.emit(event, { id }, (res) => {
      if (res?.error) toast(res.error, 'error');
    });
  }

  function sendChat(e) {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('game:chat', { id, text }, (res) => {
      if (res?.error) toast(res.error, 'error');
      else chatInput.value = '';
    });
  }

  function goTo(ply) {
    if (!state) return;
    const next = Math.max(0, Math.min(latest(), ply));
    if (next === viewPly) return;
    const step = Math.abs(next - viewPly) === 1;
    const forward = next === viewPly + 1;
    viewPly = next;
    if (forward) playSound(positions[viewPly]);
    syncBoard(step);
    renderBars();
    renderMoves();
    renderNav();
  }

  function flip() {
    orientation = orientation === 'white' ? 'black' : 'white';
    board.setOrientation(orientation);
    if (state) renderBars();
  }

  function onKey(e) {
    if (e.target.closest('input, textarea') || !state) return;
    if (e.key === 'ArrowLeft') goTo(viewPly - 1);
    else if (e.key === 'ArrowRight') goTo(viewPly + 1);
    else if (e.key === 'ArrowUp' || e.key === 'Home') goTo(0);
    else if (e.key === 'ArrowDown' || e.key === 'End') goTo(latest());
    else if (e.key === 'f') flip();
    else return;
    e.preventDefault();
  }

  // ---- wiring ---------------------------------------------------------------
  socket.on('game:move', onMove);
  socket.on('game:state', onState);
  socket.on('game:chat', onChat);
  socket.on('game:start', onStart);
  socket.on('challenge:canceled', onChallengeCanceled);
  socket.on('connect', join);
  document.addEventListener('keydown', onKey);

  const ticker = setInterval(() => {
    if (!state || disposed) return;
    if (isLive()) {
      renderClocks();
      if ((you && (goneAt[opposite(you)] != null)) || firstMoveLeftAt) renderNotices();
    }
  }, 100);

  join();

  return () => {
    disposed = true;
    clearInterval(ticker);
    socket.emit('game:leave', { id });
    socket.off('game:move', onMove);
    socket.off('game:state', onState);
    socket.off('game:chat', onChat);
    socket.off('game:start', onStart);
    socket.off('challenge:canceled', onChallengeCanceled);
    socket.off('connect', join);
    document.removeEventListener('keydown', onKey);
    root.classList.remove('wide');
    board.destroy();
  };
}
