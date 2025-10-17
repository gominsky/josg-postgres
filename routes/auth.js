const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Iniciar sesión
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  try {
    const { rows } = await db.query(`
      SELECT id, nombre, apellidos, email, rol, password_hash
      FROM usuarios
      WHERE email = $1
      LIMIT 1
    `, [email]);

    const user = rows[0];
    if (!user || !user.password_hash) {
      req.session.error = 'Correo o contraseña incorrectos';
      return res.redirect('/');
    }

    const esValida = await bcrypt.compare(password, user.password_hash || '');
    if (!esValida) {
      req.session.error = 'Correo o contraseña incorrectos';
      return res.redirect('/');
    }

    req.session.usuario = {
      id: user.id,
      nombre: user.nombre,
      rol: user.rol
    };
    req.session.usuario_id  = user.id;
    req.session.usuario_rol = user.rol;

    res.redirect('/');
  } catch (err) {
    console.error('Error al buscar usuario:', err);
    req.session.error = 'Error interno del servidor';
    res.redirect('/');
  }
});

// Cerrar sesión
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
