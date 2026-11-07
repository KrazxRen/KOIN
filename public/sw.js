const C = 'koin-v2'; // bump this when you deploy a new version
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/manifest.json', '/icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  const swr = e.request.mode !== 'navigate'; // pages: network first (always the newest app); libraries/icons: cache first
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return swr ? (hit || net) : net;
  }));
});
