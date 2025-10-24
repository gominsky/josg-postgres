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
    // Si la notificación trae una URL:
  // - si es absoluta (http/https) -> ábrela tal cual
  // - si es interna (empieza por "/") -> ve a login con next=<esa url>
  // Si no trae URL -> ve a login con next=/josgentumano/mensajes.html?m=<id>
  let href;
  if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
    href = data.url;
  } else if (typeof data.url === 'string' && data.url.startsWith('/')) {
    href = `/josgentumano/login.html?next=${encodeURIComponent(data.url)}`;
  } else {
    const base = `/josgentumano/mensajes.html${data.mensaje_id ? `?m=${encodeURIComponent(data.mensaje_id)}` : ''}`;
    href = `/josgentumano/login.html?next=${encodeURIComponent(base)}`;
  }
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
