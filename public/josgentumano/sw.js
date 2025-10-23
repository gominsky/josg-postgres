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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, mensaje_id } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      const c = all[0];
      await c.focus();
      // avisa a la página para que haga scroll/flash al mensaje, o abra el enlace
      c.postMessage({ tipo: 'abrir-mensaje', mensaje_id, url });
      // si la notificación tenía un URL directo y la ventana puede navegar, úsalo
      if (url && 'navigate' in c) { try { await c.navigate(url); } catch {} }
    } else {
      const dest = url ? url : self.asset('/mensajes.html');
      await clients.openWindow(dest);
    }
  })());
});
