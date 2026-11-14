// カップ麺タイマー Service Worker: オフライン起動 + 通知の表示・タップ処理
const CACHE = 'cup-noodle-timer-v1';
const SHELL = ['cup-noodle-timer.html', 'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ネット優先 → 失敗したらキャッシュ
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// サーバーからの Web Push を受けた場合（将来の拡張用）
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title || '🍜 できあがり！', {
    body: data.body || 'カップ麺が食べごろです。',
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'cup-noodle-timer', renotify: true
  }));
});

// 通知をタップしたらアプリを前面に
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('cup-noodle-timer.html');
  })());
});
