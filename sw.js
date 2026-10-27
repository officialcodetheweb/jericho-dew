// JERICHO DEW service worker: makes the call site installable and opens fast.
// Service data (data/…) always comes fresh from the network.
const CACHE = 'jd-shell-v7';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'livekit-client.umd.js', 'logo.png', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'fonts/lexend-latin-400-normal.woff2', 'fonts/lexend-latin-500-normal.woff2', 'fonts/lexend-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/') || url.pathname.includes('/photos/') || url.pathname.endsWith('obs.html')) return;
  // network first, fall back to cache (so updates arrive quickly)
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

// Tapping a reminder opens (or focuses) the app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
