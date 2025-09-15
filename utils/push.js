// utils/push.js
let enviarPush = async () => true; // no-op por defecto
let PUSH_ENABLED = false;

let VAPID_PUBLIC = (process.env.VAPID_PUBLIC || '').trim();
let VAPID_PRIVATE = (process.env.VAPID_PRIVATE || '').trim();

try {
  const webpush = require('web-push');

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('🔕 VAPID_PUBLIC/VAPID_PRIVATE ausentes. Modo sin notificaciones (solo bandeja).');
  } else {
    webpush.setVapidDetails('mailto:admin@tudominio.com', VAPID_PUBLIC, VAPID_PRIVATE);
    enviarPush = async (subscription, payload) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        return true;
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) return 'expired';
        console.error('❌ Error enviando push:', e?.statusCode, e?.body || e?.message);
        return false;
      }
    };
    PUSH_ENABLED = true;
    console.log('✅ web-push listo. Push ENABLED.');
  }
} catch (e) {
  console.warn('🔕 Paquete "web-push" no instalado. Modo sin notificaciones (solo bandeja).');
}

module.exports = { enviarPush, VAPID_PUBLIC, PUSH_ENABLED };
