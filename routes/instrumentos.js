const express = require('express');
const router = express.Router();
const db = require('../database/db');
const methodOverride = require('method-override');
router.use(methodOverride('_method'));

// Definición de familias
const FAMILIAS = [
  'Cuerda',
  'Percusión',
  'Viento madera',
  'Viento metal',
  'Otra'
];

// Listado de instrumentos
router.get('/', (req, res) => {
  db.all('SELECT * FROM instrumentos ORDER BY nombre', [], (err, instrumentos) => {
    if (err) {
      console.error('Error cargando instrumentos:', err);
      return res.status(500).send('Error cargando instrumentos');
    }
    res.render('instrumentos_lista', { instrumentos });
  });
});

// Formulario para nuevo instrumento
router.get('/nuevo', (req, res) => {
  res.render('instrumentos_ficha', { instrumento: null, familias: FAMILIAS });
});

// Formulario para editar instrumento existente
router.get('/:id/editar', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM instrumentos WHERE id = ?', [id], (err, instrumento) => {
    if (err) {
      console.error('Error al obtener instrumento:', err);
      return res.status(500).send('Error al cargar instrumento');
    }
    if (!instrumento) {
      return res.status(404).send('Instrumento no encontrado');
    }
    res.render('instrumentos_ficha', { instrumento, familias: FAMILIAS });
  });
});

// Crear nuevo instrumento
router.post('/', (req, res) => {
  const { nombre, familia } = req.body;
  db.run(
    'INSERT INTO instrumentos (nombre, familia) VALUES (?, ?)',
    [nombre, familia],
    err => {
      if (err) {
        console.error('Error al guardar instrumento:', err);
        return res.status(500).send('Error al guardar instrumento');
      }
      res.redirect('/instrumentos');
    }
  );
});

// Actualizar instrumento (vía POST desde form edición)
router.post('/editar/:id', (req, res) => {
  const id = req.params.id;
  const { nombre, familia } = req.body;
  db.run(
    'UPDATE instrumentos SET nombre = ?, familia = ? WHERE id = ?',
    [nombre, familia, id],
    err => {
      if (err) {
        console.error('Error al actualizar instrumento:', err);
        return res.status(500).send('Error al actualizar instrumento');
      }
      res.redirect('/instrumentos');
    }
  );
});

// Actualizar instrumento (vía PUT RESTful)
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const { nombre, familia } = req.body;
  db.run(
    'UPDATE instrumentos SET nombre = ?, familia = ? WHERE id = ?',
    [nombre, familia, id],
    err => {
      if (err) {
        console.error('Error al actualizar instrumento:', err);
        return res.status(500).send('Error al actualizar instrumento');
      }
      res.redirect('/instrumentos');
    }
  );
});

// Eliminar instrumento
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM instrumentos WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Error al eliminar instrumento:', err);
      return res.status(500).send('Error al eliminar instrumento');
    }
    res.redirect('/instrumentos');
  });
});

module.exports = router;
