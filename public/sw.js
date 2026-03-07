const CACHE = 'hdshot-il-v9';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return; // Never cache API
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  const title  = data.title  || '🚨 אזעקה';
  const options = {
    body:               data.body   || 'אזעקה פעילה',
    icon:               data.icon   || '/icon-192.png',
    badge:              data.badge  || '/icon-192.png',
    vibrate:            data.vibrate || [300, 100, 300, 100, 300],
    requireInteraction: true,
    dir:                'rtl',
    lang:               'he',
    tag:                'alert',          // replace previous notification
    renotify:           true,
    data:               data.data || { url: '/' }
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Click on notification → open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'ALERT_CLICK', url });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
