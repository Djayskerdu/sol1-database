
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});

  // When a new deploy's service worker takes control of an already-open
  // tab (sw.js uses skipWaiting()+clients.claim(), so this happens
  // automatically without the user doing anything), that tab is still
  // running the OLD page's JS/DOM in memory. Without this, clicking into
  // a screen that changed in the new deploy can silently fail (e.g. go()
  // targeting an element that no longer matches) and show a blank pane.
  // Reloading once when control changes keeps every open tab in sync.
  let _swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swRefreshing) return;
    _swRefreshing = true;
    window.location.reload();
  });
}