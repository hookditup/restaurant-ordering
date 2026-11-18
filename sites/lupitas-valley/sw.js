/* Lupita's Valley app: shows a friendly page when offline. Nothing else is cached, so prices and hours are never stale. */
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => { e.waitUntil(caches.open('lv-v1').then((c) => c.add(OFFLINE))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== 'lv-v1').map((n) => caches.delete(n))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
