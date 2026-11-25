// If the app never starts (usually because the page is served by a static host
// with no Rookery server behind it), replace "Loading…" with an explanation.
(function () {
  function fail() {
    if (document.documentElement.dataset.booted) return;
    var main = document.getElementById('app');
    if (!main) return;
    main.innerHTML =
      '<div class="card notfound">' +
      '<h1>The game server isn’t running</h1>' +
      '<p>This page was loaded, but the Rookery server it needs could not be reached. ' +
      'Rookery is a Node.js app: it has to run on a host that runs servers (for example Render, Railway or Fly.io). ' +
      'Static hosting such as Cloudflare Pages, GitHub Pages or Netlify can’t run it.</p>' +
      '<p class="muted">See the “Deploying” section of the README for step-by-step instructions.</p>' +
      '</div>';
  }
  // The socket.io client is served by the server itself; if it's missing, there is no server.
  window.addEventListener('load', function () {
    if (typeof window.io === 'undefined') fail();
    else setTimeout(fail, 8000);
  });
})();
