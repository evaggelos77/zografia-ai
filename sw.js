// Ζωγραφιά με Ζωή AI — cache-first service worker.
const CACHE = 'zografia-v22';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.json',
  'assets/logo.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Drop every old cache entirely.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    // 2. Become the controller for already-open pages.
    await self.clients.claim();
    // 3. Force-reload every open tab so it picks up the new HTML/JS.
    //    (Without this, the user keeps running the old in-memory bundle
    //    until they manually refresh, which is what caused the camera
    //    auto-open bug to "come back".)
    const wins = await self.clients.matchAll({ type: 'window' });
    for (const w of wins) { try { w.navigate(w.url); } catch (e) {} }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache API calls
  if (url.pathname.startsWith('/api/')) return;
  // For navigations (HTML), prefer network so the app HTML is always fresh.
  // This stops us from ever serving a stale index.html again.
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(c => c || caches.match('index.html')))
    );
    return;
  }
  // Other assets: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('index.html'));
    })
  );
});
