const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const db      = require('../database/db'); // <-- igual que en app.js
const router  = express.Router();

const saltRounds = 10;

// GET pedir email
router.get('/', (req, res) => {
  res.render('recuperar', { error: null, ok: null, title: 'Recuperar contraseña' });
});

// POST generar token y mandar email
router.post('/', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const okMsg = 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer la contraseña.';

  try {
    const { rows } = await db.query('SELECT id, email FROM usuarios WHERE email = $1 LIMIT 1', [email]);
    if (rows.length === 0) {
      return res.render('recuperar', { error: null, ok: okMsg, title: 'Recuperar contraseña' });
    }
    const user = rows[0];

    // token aleatorio + hash para BD
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await db.query(
      `INSERT INTO password_resets (usuario_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const link    = `${baseUrl}/restablecer/${token}`;

    // --- ENVÍO DE EMAIL (usa tu proveedor SMTP)
    // Si ya tienes un servicio de correo, llama aquí a tu función de envío.
    // Con nodemailer sería algo así:
    /*
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || '"JOSG Manager" <no-reply@tudominio>',
      to: user.email,
      subject: 'Restablece tu contraseña',
      html: `<p>Haz clic para restablecer (válido 1h): <a href="${link}">${link}</a></p>`
    });
    */

    return res.render('recuperar', { error: null, ok: okMsg, title: 'Recuperar contraseña' });
  } catch (e) {
    console.error(e);
    return res.render('recuperar', { error: 'Ha ocurrido un error. Inténtalo de nuevo.', ok: null, title: 'Recuperar contraseña' });
  }
});

// GET formulario nueva contraseña
router.get('/restablecer/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const { rows } = await db.query(
    `SELECT pr.id, u.id AS usuario_id
       FROM password_resets pr
       JOIN usuarios u ON u.id = pr.usuario_id
      WHERE pr.token_hash = $1
        AND pr.used_at IS NULL
        AND pr.expires_at > NOW()
      LIMIT 1`,
    [tokenHash]
  );
  if (rows.length === 0) {
    return res.render('restablecer', { error: 'Enlace inválido o caducado.', ok: null, token: null, title: 'Restablecer' });
  }
  res.render('restablecer', { error: null, ok: null, token: req.params.token, title: 'Restablecer' });
});

// POST guardar nueva contraseña
router.post('/restablecer/:token', async (req, res) => {
  const { password, confirm } = req.body;
  if (!password || password.length < 8 || password !== confirm) {
    return res.render('restablecer', { error: 'Las contraseñas no coinciden o son demasiado cortas (min. 8).', ok: null, token: req.params.token, title: 'Restablecer' });
  }
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const { rows } = await db.query(
    `SELECT pr.id, u.id AS usuario_id
       FROM password_resets pr
       JOIN usuarios u ON u.id = pr.usuario_id
      WHERE pr.token_hash = $1
        AND pr.used_at IS NULL
        AND pr.expires_at > NOW()
      LIMIT 1`,
    [tokenHash]
  );
  if (rows.length === 0) {
    return res.render('restablecer', { error: 'Enlace inválido o caducado.', ok: null, token: null, title: 'Restablecer' });
  }

  const hash = await bcrypt.hash(password, saltRounds);
  await db.query('UPDATE usuarios SET password = $1 WHERE id = $2', [hash, rows[0].usuario_id]);
  await db.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [rows[0].id]);

  return res.render('restablecer', { error: null, ok: 'Contraseña actualizada. Ya puedes iniciar sesión.', token: null, title: 'Restablecer' });
});

module.exports = router;
