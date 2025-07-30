const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Iniciar sesión
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);

    const user = result.rows[0];
    if (!user) {
      req.session.error = 'Correo o contraseña incorrectos';
      return res.redirect('/');
    }

    const esValida = await bcrypt.compare(password, user.password);
    if (!esValida) {
      req.session.error = 'Correo o contraseña incorrectos';
      return res.redirect('/');
    }

    req.session.usuario = {
      id: user.id,
      nombre: user.nombre,
      rol: user.rol
    };
    res.redirect('/');
  } catch (err) {
    console.error('Error al buscar usuario:', err);
    req.session.error = 'Error interno del servidor';
    res.redirect('/');
  }
});

// Cerrar sesión
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;