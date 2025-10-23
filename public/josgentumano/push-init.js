(async function initPush() {
  const alumnoId = Number(localStorage.getItem('alumno_id')||0);
  if (!alumnoId) return;                            // solo si está logueado
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    // registra el SW con scope
    const reg = await navigator.serviceWorker.register('/josgentumano/sw.js', { scope: '/josgentumano/' });

    // pide permiso si aún no se concedió
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;

    // clave pública VAPID
    const { key } = await (await fetch('/push/public-key')).json();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
    const token = localStorage.getItem('token');
    await fetch('/mensajes/push/subscribe', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'Authorization': 'Bearer ' + token } : {}
      ),
      body: JSON.stringify({
        alumno_id: alumnoId,
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys
      })
    });

  } catch (e) {
    console.error('❌ Registro push:', e);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }
  
})();
