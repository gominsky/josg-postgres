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
    const { url, mensaje_id } = event.notification.data || {};
    event.waitUntil((async () => {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (all.length) {
        all[0].focus();
        all[0].postMessage({ tipo: 'abrir-mensaje', mensaje_id, url });
        return;
      }
      // No hay ventana: llevar a login con redirección a la bandeja
      const next = encodeURIComponent(`/josgentumano/mensajes.html${mensaje_id ? `?m=${mensaje_id}` : ''}`);
      await clients.openWindow(`/josgentumano/login.html?next=${next}`);
    })());
});
