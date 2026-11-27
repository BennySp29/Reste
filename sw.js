const APP_VERSION = 'v8';
const CACHE_NAME = `reste-shell-${APP_VERSION}`;
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css?v=8',
  './app.js?v=8',
  './budget-engine.js?v=8',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          SHELL_ASSETS.map(async (assetUrl) => {
            const req = new Request(assetUrl, { cache: 'reload' });
            const res = await fetch(req);
            if (res && res.ok) {
              await cache.put(assetUrl, res);
            }
          })
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldKeys = keys.filter((k) => k !== CACHE_NAME);
      const hadOldCaches = oldKeys.length > 0;
      await Promise.all(oldKeys.map((k) => caches.delete(k)));
      await self.clients.claim();

      if (hadOldCaches) {
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windowClients) {
          try {
            client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION });
          } catch (_) {
            // ignore
          }
        }
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache Supabase Auth, REST, or Realtime traffic
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in')) {
    return;
  }

  // Only handle same-origin app shell assets with network-first + cache validation
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((cached) => cached || caches.match(req, { ignoreSearch: true }))
          .then((cached) => cached || caches.match('./index.html'))
      )
  );
});
