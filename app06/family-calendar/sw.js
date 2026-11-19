// かぞくカレンダー Service Worker
// アプリの画面（HTML・JS・アイコン）をキャッシュして、電波がなくても起動できるようにします。
// 予定データは Firebase（Firestore）が自分でオフライン保存するので、ここでは扱いません。
const CACHE = 'family-calendar-v1';
const SHELL = [
  'family-calendar.html', 'app.js', 'store.js', 'firebase-config.js',
  'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('family-calendar-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Firebase など外部への通信はそのまま
  // ネット優先 → つながらなければキャッシュ（push した最新版がすぐ反映されるように）
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
