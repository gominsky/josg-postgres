const express = require('express');
const router = express.Router();

// Sólo admin puede acceder
const { isAdmin } = require('../middleware/auth');
// Centro de ayuda (en Configuración)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_menu', { title: 'Centro de ayuda', hero: false });
});

router.get('/', isAdmin, (req, res) => {
  res.render('configuracion_menu', {
    usuario: req.session.usuario
  });
});

module.exports = router;