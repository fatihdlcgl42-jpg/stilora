// Stilora service worker: uygulama dosyalarını önbelleğe alır, çevrimdışı açılmayı sağlar.
const CACHE = 'stilora-v0.8.2';
const SHELL = ['./', 'index.html', 'style.css', 'js/app.js', 'js/db.js', 'js/model.js', 'js/ai.js', 'js/weather.js', 'js/zip.js', 'js/bg.js', 'js/avatar.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('stilora-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Önce ağ (güncellemeler hemen gelsin), ağ yoksa önbellek. Yalnız kendi dosyalarımız.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
