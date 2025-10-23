self.asset = (p) => new URL(p, self.registration.scope).toString();
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch {}
  const title = data.titulo || 'Nuevo mensaje';
  const options = {
    body: data.cuerpo || '',
    data: { mensaje_id: data.mensaje_id, url: data.url || null },
    badge: data.badge || self.asset('/imagenes/badge.png'),
    icon:  data.icon  || self.asset('/imagenes/icon-192.png')
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const href = (typeof data.url === 'string' && /^https?:\/\//i.test(data.url))
    ? data.url
    : '/firmass/mensajes.html'; // siempre absoluta y correcta

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      const c = all[0];
      try { await c.focus(); } catch {}
      try { c.postMessage({ tipo:'abrir-mensaje', mensaje_id: data.mensaje_id, url: data.url || null }); } catch {}
    }
    await clients.openWindow(href);
  })());
});
