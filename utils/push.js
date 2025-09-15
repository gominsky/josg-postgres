const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;

webpush.setVapidDetails(
  'mailto:admin@tudominio.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

async function enviarPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    // Si 410/404, elimina suscripción caducada
    if (err.statusCode === 410 || err.statusCode === 404) return 'expired';
    console.error('❌ Push error', err.statusCode, err.body);
    return false;
  }
}

module.exports = { enviarPush, VAPID_PUBLIC };
