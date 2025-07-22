const express = require('express');
const router = express.Router();

// Sólo admin puede acceder
const { isAdmin } = require('../middleware/auth');

router.get('/', isAdmin, (req, res) => {
  res.render('configuracion_lista', {
    usuario: req.session.usuario
  });
});

module.exports = router;