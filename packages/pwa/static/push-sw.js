// SPDX-License-Identifier: AGPL-3.0-or-later
/* Push handling, imported by the generated service worker (workbox importScripts). */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Beamhop', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Beamhop';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/admin/icon-192.png',
      badge: '/admin/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/admin/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/admin/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/admin') && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
