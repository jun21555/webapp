// 株ノート Service Worker: ネット優先。オフラインのときは最後に読んだアプリ本体とデータを表示する
const CACHE = 'kabu-note-v1';
const SHELL = ['kabu-note.html', 'kabu-note.js', 'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'yutai.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('kabu-note') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
