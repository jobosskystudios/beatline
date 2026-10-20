// Offline support: serve the app from cache, refresh the cache in the background.
const CACHE = 'beatline-v4';
const SHELL = [
  './', 'index.html', 'guide.html', 'how-it-works.html', 'faq.html', 'styles.css', 'icon.svg',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/dsp.js', 'js/analysis.js', 'js/worker.js', 'js/player.js', 'js/timeline.js', 'js/fileinfo.js',
  'js/markers.js', 'js/fcpxml.js', 'js/structure.js', 'js/cutplan.js',
  'js/insights.js', 'js/musicedit.js', 'js/clips.js', 'js/exports.js', 'js/paths.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
