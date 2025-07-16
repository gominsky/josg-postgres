const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Listado de tipos de cuota
router.get('/', (req, res) => {
  db.all('SELECT * FROM tipos_cuota ORDER BY tipo', [], (err, filas) => {
    if (err) {
      console.error('Error cargando tipos de cuota:', err.message);
      return res.status(500).send('Error al cargar los tipos de cuota');
    }
    res.render('tipos_cuotas_lista', {
      tipos_cuota: filas,
      hero: false
    });
  });
});

// GET: Formulario nuevo tipo
  router.get('/nueva', (req, res) => {
    res.render('tipos_cuotas_ficha', { tipo: null, hero: false });
  });

// POST: Crear tipo
router.post('/', (req, res) => {
  const { tipo } = req.body;
  db.run('INSERT INTO tipos_cuota (tipo) VALUES (?)', [tipo], err => {
    if (err) return res.status(500).send('Error al guardar tipo de cuota');
    res.redirect('/tipos_cuotas');
  });
});

// GET: Formulario edición
router.get('/editar/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM tipos_cuota WHERE id = ?', [id], (err, fila) => {
    if (err) {
      console.error('Error consultando tipo de cuota:', err.message);
      return res.status(500).send('Error al consultar el tipo de cuota');
    }

    if (!fila) return res.status(404).send('Tipo de cuota no encontrado');

    res.render('tipos_cuotas_ficha', { tipo: fila, hero: false });
  });
});

// POST: Actualizar tipo
router.post('/editar/:id', (req, res) => {
  const id = req.params.id;
  const { tipo } = req.body;
  db.run('UPDATE tipos_cuota SET tipo = ? WHERE id = ?', [tipo, id], err => {
    if (err) return res.status(500).send('Error al actualizar tipo de cuota');
    res.redirect('/tipos_cuotas');
  });
});

// routes/tipos_cuotas.js
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM tipos_cuota WHERE id = ?', [id], function(err) {
    if (err) {
      req.session.mensaje = 'No se pudo eliminar el tipo de cuota';
    } else {
      req.session.mensaje = 'Tipo de cuota eliminado';
    }
    res.redirect('/tipos_cuotas');
  });
});
module.exports = router;