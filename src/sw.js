/* Only the install shell is handled here. Authenticated pages and API responses are never cached. */
const VERSION = 'tube-autopilot-pwa-v1';
self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith('tube-autopilot-pwa-') && key !== VERSION) await caches.delete(key); await self.clients.claim(); })()); });
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || req.mode === 'navigate') return;
  if (!['/styles.css', '/icon.svg'].includes(url.pathname)) return;
  event.respondWith(fetch(req).then(response => response).catch(() => caches.match(req)));
});
