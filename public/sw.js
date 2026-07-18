const CACHE = 'paperlight-v8';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;
  const isNavigation = event.request.mode === 'navigate';

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Navigations are network-first so a new deploy is picked up immediately,
    // with the cached app shell as an offline fallback.
    if (isNavigation) {
      try {
        const response = await fetch(event.request);
        if (response.ok) cache.put('./', response.clone());
        return response;
      } catch {
        return (await caches.match(event.request)) || (await caches.match('./')) || Response.error();
      }
    }

    // Everything else (content-hashed bundles, icons, fonts, the OCR model) is
    // cache-first: fast, and it keeps the app fully working offline.
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok && (isLocal || event.request.url.includes('tessdata') || url.hostname.includes('fonts'))) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
