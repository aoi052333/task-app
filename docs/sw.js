// オフラインでも画面を開けるようにするための Service Worker
// アプリを更新したら VERSION の数字を上げる（index.html の ?v= も合わせる）
const VERSION = 'v13';
const CACHE = 'taskapp-' + VERSION;
const FILES = ['./', 'index.html', 'style.css?v=13', 'app.js?v=13', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/favicon.svg', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  // ブラウザの一時保存を使わず、必ずサーバーから最新を取得してキャッシュする
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 自分のファイルは「ネット優先（毎回サーバーに確認）・失敗したらキャッシュ」。同期API（別ドメイン）は触らない
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
