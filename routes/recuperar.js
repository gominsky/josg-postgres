// routes/recuperar.js
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const db      = require('../database/db');
const router  = express.Router();

const saltRounds = 10;

// Mensaje genérico para no revelar si el email existe o no
const OK_MSG = 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer la contraseña.';

// --- Helper: enviar email de recuperación ---
// Requiere en .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL
async function enviarEmailRecuperacion(toEmail, link) {
  const nodemailer = require('nodemailer');

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true para puerto 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from:    process.env.FROM_EMAIL || '"JOSG Manager" <no-reply@josg.local>',
    to:      toEmail,
    subject: 'Restablece tu contraseña — JOSG',
    text:    `Haz clic en el siguiente enlace para restablecer tu contraseña (válido 1 hora):\n\n${link}\n\nSi no solicitaste este cambio, ignora este mensaje.`,
    html:    `
      <p>Haz clic en el siguiente enlace para restablecer tu contraseña (válido <strong>1 hora</strong>):</p>
      <p><a href="${link}">${link}</a></p>
      <p style="color:#888;font-size:12px;">Si no solicitaste este cambio, ignora este mensaje.</p>
    `
  });
}

// ─── GET /recuperar — formulario para pedir el email ───────────────────────
router.get('/', (req, res) => {
  res.render('recuperar', { error: null, ok: null, title: 'Recuperar contraseña' });
});

// ─── POST /recuperar — generar token y enviar email ────────────────────────
router.post('/', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  try {
    const { rows } = await db.query(
      'SELECT id, email FROM usuarios WHERE email = $1 LIMIT 1',
      [email]
    );

    // Respuesta genérica tanto si existe como si no (evita enumeración de usuarios)
    if (rows.length === 0) {
      return res.render('recuperar', { error: null, ok: OK_MSG, title: 'Recuperar contraseña' });
    }

    const user = rows[0];

    // Token aleatorio + hash para almacenar en BD (nunca guardamos el token en claro)
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await db.query(
      `INSERT INTO password_resets (usuario_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const link    = `${baseUrl}/recuperar/restablecer/${token}`;

    // Intentar enviar el email; si falla, logueamos pero no revelamos el error al usuario
    try {
      await enviarEmailRecuperacion(user.email, link);
    } catch (emailErr) {
      console.error('[recuperar] Error enviando email:', emailErr.message);
      // En desarrollo, mostramos el enlace en consola para poder probarlo sin SMTP
      if (process.env.NODE_ENV !== 'production') {
        console.log('[recuperar] Enlace de recuperación (dev):', link);
      }
    }

    return res.render('recuperar', { error: null, ok: OK_MSG, title: 'Recuperar contraseña' });
  } catch (e) {
    console.error('[recuperar] Error generando token:', e);
    return res.render('recuperar', {
      error: 'Ha ocurrido un error. Inténtalo de nuevo.',
      ok: null,
      title: 'Recuperar contraseña'
    });
  }
});

// ─── GET /recuperar/restablecer/:token — formulario nueva contraseña ────────
router.get('/restablecer/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

  try {
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

    if (!rows.length) {
      return res.render('restablecer', {
        error: 'Enlace inválido o caducado.',
        ok: null,
        token: null,
        title: 'Restablecer contraseña'
      });
    }

    res.render('restablecer', {
      error: null,
      ok: null,
      token: req.params.token,
      title: 'Restablecer contraseña'
    });
  } catch (e) {
    console.error('[recuperar] Error validando token:', e);
    res.render('restablecer', {
      error: 'Ha ocurrido un error. Inténtalo de nuevo.',
      ok: null,
      token: null,
      title: 'Restablecer contraseña'
    });
  }
});

// ─── POST /recuperar/restablecer/:token — guardar nueva contraseña ──────────
router.post('/restablecer/:token', async (req, res) => {
  const { password, confirm } = req.body;

  if (!password || password.length < 8 || password !== confirm) {
    return res.render('restablecer', {
      error: 'Las contraseñas no coinciden o son demasiado cortas (mínimo 8 caracteres).',
      ok: null,
      token: req.params.token,
      title: 'Restablecer contraseña'
    });
  }

  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

  try {
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

    if (!rows.length) {
      return res.render('restablecer', {
        error: 'Enlace inválido o caducado.',
        ok: null,
        token: null,
        title: 'Restablecer contraseña'
      });
    }

    const { id: resetId, usuario_id } = rows[0];
    const hash = await bcrypt.hash(password, saltRounds);

    // ✅ CORREGIDO: columna correcta es password_hash, no password
    await db.query(
      'UPDATE usuarios SET password_hash = $1 WHERE id = $2',
      [hash, usuario_id]
    );

    // Marcar el token como usado para que no pueda reutilizarse
    await db.query(
      'UPDATE password_resets SET used_at = NOW() WHERE id = $1',
      [resetId]
    );

    return res.render('restablecer', {
      error: null,
      ok: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.',
      token: null,
      title: 'Restablecer contraseña'
    });
  } catch (e) {
    console.error('[recuperar] Error actualizando contraseña:', e);
    return res.render('restablecer', {
      error: 'Ha ocurrido un error al guardar la contraseña. Inténtalo de nuevo.',
      ok: null,
      token: req.params.token,
      title: 'Restablecer contraseña'
    });
  }
});

module.exports = router;
