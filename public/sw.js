const CACHE = 'paperlight-v4';
const CORE = ['./', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const isLocal = event.request.url.startsWith(self.location.origin);
    const cached = await caches.match(event.request);
    if (!isLocal && cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok && (isLocal || event.request.url.includes('tessdata'))) {
        const copy = response.clone();
        const cache = await caches.open(CACHE);
        await cache.put(event.request, copy);
      }
      return response;
    } catch {
      return caches.match('./');
    }
  })());
});
