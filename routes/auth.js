const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Iniciar sesión
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  const sql = 'SELECT * FROM usuarios WHERE email = ?';
  db.get(sql, [email], async (err, user) => {
    if (err) {
      console.error('Error al buscar usuario:', err);
      req.session.error = 'Error interno del servidor';
      return res.redirect('/');
    }

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
  });
});

// Cerrar sesión
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
