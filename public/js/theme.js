// Applied before first paint to avoid a flash of the wrong theme.
(function () {
  try {
    var d = document.documentElement;
    var t = JSON.parse(localStorage.getItem('theme') || '"dark"');
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    d.dataset.theme = t;
    d.dataset.board = JSON.parse(localStorage.getItem('board') || '"green"');
  } catch (e) { /* storage unavailable */ }
})();
