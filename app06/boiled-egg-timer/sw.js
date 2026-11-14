// ゆで卵タイマー Service Worker: オフライン起動 + 通知の表示・タップ処理
const CACHE = 'boiled-egg-timer-v1';
const SHELL = ['boiled-egg-timer.html', 'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

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
  e.waitUntil(self.registration.showNotification(data.title || '🥚 ゆで上がり！', {
    body: data.body || '卵がゆで上がりました。すぐ冷水へ！',
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'boiled-egg-timer', renotify: true
  }));
});

// 通知をタップしたらアプリを前面に
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('boiled-egg-timer.html');
  })());
});
