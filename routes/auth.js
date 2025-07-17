const express = require('express');
const router = express.Router();
const db = require('../database/db');

// Iniciar sesión
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const sql = 'SELECT * FROM usuarios WHERE email = ? AND password = ?';
  db.get(sql, [email, password], (err, user) => {
    if (err) {
      req.session.error = 'Error interno del servidor';
      return res.redirect('/');
    }
    if (!user) {
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
