const CACHE_NAME = 'essen-cache-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=3',
  '/app.js?v=3',
  '/db.js?v=3',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-256.png',
  '/icon-512.png',
  '/icon-1024.png',
  '/muster.jpg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Network-first for API calls, cache-first for others
  if (new URL(req.url).pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
