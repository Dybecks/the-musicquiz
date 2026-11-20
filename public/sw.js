/*
 * Service worker: makes the game installable (and wrappable as an Android app)
 * and lets it start without a connection. Spotify is never cached: only this
 * site's own files are.
 *  - Pages: network first, so a new deploy (or the Spotify login redirect) is
 *    always fresh; the cached page is the fallback when offline.
 *  - Other files: cache first. Vite gives built files hashed names, so a cached
 *    copy is never stale.
 */
const CACHE = 'mq-v1';
const SHELL = new URL('./', self.location).href;

// Cache the page and the scripts and styles it links to, so the first visit
// is enough to play offline later.
async function cacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL, { cache: 'no-cache' });
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  const files = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|webmanifest|svg|png))"/g)]
    .map((m) => new URL(m[1], SHELL).href)
    .filter((url) => url.startsWith(self.location.origin));
  await cache.addAll([...new Set(files)]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL, { ignoreVary: true })),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
