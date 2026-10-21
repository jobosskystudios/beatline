// Offline support: always load the newest files, fall back to the cache offline.
const CACHE = 'beatline-v6';
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
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Newest files first; the cache only answers when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
