// "Create a game" / "Play with a friend" dialog.
import { h, toast, formatMinutes, storage, capitalize } from '../util.js';
import { pieceSvg } from '../board.js';

const MINUTES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 35, 40, 45, 60, 75, 90, 120, 150, 180];
const INCREMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 45, 60, 90, 120, 180];

const category = (m, i) => {
  const e = m * 60 + 40 * i;
  return e < 180 ? 'bullet' : e < 480 ? 'blitz' : e < 1500 ? 'rapid' : 'classical';
};

/** @param {'seek'|'friend'} mode */
export function openGameDialog(ctx, mode) {
  const saved = storage.get('createPrefs', { minutes: 5, increment: 3, rated: true });
  let minutesIdx = Math.max(0, MINUTES.indexOf(saved.minutes));
  let incIdx = Math.max(0, INCREMENTS.indexOf(saved.increment));
  let rated = Boolean(ctx.me) && saved.rated;

  const minLabel = h('strong');
  const incLabel = h('strong');
  const catLabel = h('span.cat-label');
  const minInput = h('input', { type: 'range', min: 0, max: MINUTES.length - 1, value: minutesIdx, 'aria-label': 'Minutes per side' });
  const incInput = h('input', { type: 'range', min: 0, max: INCREMENTS.length - 1, value: incIdx, 'aria-label': 'Increment in seconds' });

  const update = () => {
    minutesIdx = Number(minInput.value);
    incIdx = Number(incInput.value);
    minLabel.textContent = formatMinutes(MINUTES[minutesIdx]);
    incLabel.textContent = String(INCREMENTS[incIdx]);
    catLabel.textContent = capitalize(category(MINUTES[minutesIdx], INCREMENTS[incIdx]));
  };
  minInput.addEventListener('input', update);
  incInput.addEventListener('input', update);
  update();

  const modeBtn = (value, label) => {
    const b = h('button.seg', {
      type: 'button',
      class: rated === value ? 'active' : '',
      disabled: value && !ctx.me,
      title: value && !ctx.me ? 'Sign in to play rated games' : '',
      on: {
        click: () => {
          rated = value;
          modes.querySelectorAll('.seg').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
        },
      },
    }, label);
    return b;
  };
  const modes = h('div.segmented', modeBtn(false, 'Casual'), modeBtn(true, 'Rated'));

  const colorBtn = (color, title) =>
    h('button.color-btn', {
      type: 'button',
      title,
      'aria-label': title,
      on: { click: () => submit(color) },
    }, color === 'random' ? h('span.half-king', pieceSvg('wk'), pieceSvg('bk')) : pieceSvg(color === 'white' ? 'wk' : 'bk'));

  const dialog = h('dialog.modal',
    h('form', { method: 'dialog', on: { submit: (e) => e.preventDefault() } },
      h('button.close', { type: 'button', 'aria-label': 'Close', on: { click: () => dialog.close() } }, '×'),
      h('h2', mode === 'friend' ? 'Play with a friend' : 'Create a game'),
      h('div.field', h('div.field-label', 'Minutes per side: ', minLabel), minInput),
      h('div.field', h('div.field-label', 'Increment in seconds: ', incLabel), incInput),
      h('div.field.center', catLabel),
      h('div.field', modes),
      !ctx.me ? h('p.muted.center.small', 'Rated games need an account. ', h('a', { href: '/register', on: { click: () => dialog.close() } }, 'Register for free')) : null,
      h('div.field-label.center', 'Choose your side'),
      h('div.colors', colorBtn('black', 'Play as black'), colorBtn('random', 'Random side'), colorBtn('white', 'Play as white'))));

  function submit(color) {
    const minutes = MINUTES[minutesIdx];
    const increment = INCREMENTS[incIdx];
    storage.set('createPrefs', { minutes, increment, rated });
    const event = mode === 'friend' ? 'challenge:create' : 'seek:create';
    ctx.socket.emit(event, { minutes, increment, rated, color }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
        return;
      }
      dialog.close();
      if (mode === 'friend') ctx.navigate(`/game/${res.id}`);
      else {
        toast('Seek created — waiting for an opponent');
        window.dispatchEvent(new CustomEvent('seek-created'));
      }
    });
  }

  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}
