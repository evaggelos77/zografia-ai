// Ζωγραφιά με Ζωή AI — cache-first service worker.
const CACHE = 'zografia-v1';
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
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Never cache API calls
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('index.html'));
    })
  );
});
