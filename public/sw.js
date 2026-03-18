const APP_VERSION = '31';
const CACHE = 'hdshot-il-v' + APP_VERSION;
const ASSETS = ['/', '/index.html', '/css/app.css', '/js/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

// ── INSTALL: cache assets, skip waiting immediately ──
self.addEventListener('install', e => {
  console.log('[SW] Installing v' + APP_VERSION);
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: nuke ALL old caches, claim all clients, force reload ──
self.addEventListener('activate', e => {
  console.log('[SW] Activating v' + APP_VERSION);
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    )
    .then(() => self.clients.claim())
    .then(() => {
      return self.clients.matchAll({ type: 'window' }).then(tabs => {
        tabs.forEach(tab => {
          tab.postMessage({ type: 'SW_UPDATED', version: APP_VERSION });
          tab.navigate(tab.url);
        });
      });
    })
  );
});

// ── FETCH: network-first for HTML, cache-first for assets ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('/api/') || url.includes('/health')) {
    // Cache image proxy responses for performance
    if (url.includes('/api/img-proxy')) {
      e.respondWith(
        caches.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
          }).catch(() => new Response('', { status: 502 }));
        })
      );
    }
    return;
  }

  if (url.endsWith('/') || url.includes('index.html') || url.includes('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  if (url.includes('sw.js')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});

// ── MESSAGE: handle force-update commands from client ──
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'FORCE_UPDATE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => {
        self.clients.matchAll({ type: 'window' }).then(tabs => {
          tabs.forEach(tab => tab.navigate(tab.url));
        });
      });
  }
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {
    console.warn('[SW] Failed to parse push data:', err);
  }
  console.log('[SW] Push received:', JSON.stringify(data).slice(0, 100));
  const title = data.title || '🚨 אזעקה';
  const options = {
    body: data.body || 'אזעקה פעילה',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    image: data.image || undefined,
    vibrate: data.vibrate || [200, 80, 200],
    requireInteraction: data.requireInteraction || false,
    silent: false,
    dir: 'rtl', lang: 'he',
    tag: data.tag || 'news',
    renotify: true,
    data: data.data || { url: '/' },
    actions: data.requireInteraction ? [{ action: 'open', title: 'פתח' }, { action: 'dismiss', title: 'סגור' }] : undefined
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const appClient = list.find(c => c.url.startsWith(self.location.origin));
      if (appClient) {
        appClient.navigate(url);
        return appClient.focus();
      }
      return clients.openWindow(url);
    })
  );
});
