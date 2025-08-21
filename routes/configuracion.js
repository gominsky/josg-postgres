const express = require('express');
const router = express.Router();

// Sólo admin puede acceder
const { isAdmin } = require('../middleware/auth');
// Centro de ayuda (en Configuración)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_menu', { title: 'Centro de ayuda', hero: false });
});
// routes/alumnos.js (o donde tengas las rutas de alumnos)
router.get(['/alumnos/ayuda', '/musicos/ayuda'], (_req, res) => {
  res.render('ayuda_musicos', { title: 'Ayuda · Músicos', hero: false });
});

router.get('/', isAdmin, (req, res) => {
  res.render('configuracion_lista', {
    usuario: req.session.usuario
  });
});

module.exports = router;