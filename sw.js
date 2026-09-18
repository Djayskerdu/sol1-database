const CACHE_NAME = 'sol1-v3'; // bumped so every phone purges old cached files (including any stale gameshow.html from before these fixes) on next load
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/script1.js',
  '/js/script2.js',
  '/icon-192.png',
  '/icon-512.png',
  '/assets/church-logo.png',
  '/assets/sol-logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // FIX: never intercept calls to Apps Script. This used to catch a failed
  // request and hand back a fake, empty `{ }` JSON response instead of
  // letting the error propagate — which meant a phone whose buzz or poll
  // request failed (a brief WiFi drop, common on crowded venue networks,
  // rare on a stable desktop connection) would still see the request
  // "succeed" with empty data. The app's own code only checks whether the
  // fetch resolved, not whether it actually contains real data, so it
  // confidently showed "Buzz sent!" for a buzz that never reached the
  // server. By not calling respondWith() here at all, these requests go
  // straight to the network with no service-worker involvement, so a real
  // failure is a real rejected Promise — which the app's existing retry
  // logic (in broadcast()) and error UI (in pressBuzzer()'s .catch()) can
  // actually see and react to, instead of it being hidden.
  if (e.request.url.includes('script.google.com')) {
    return;
  }
  // Network-first for all assets: always fetch fresh, fall back to cache when offline
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});