const express = require('express');
const router = express.Router();
const db = require('../database/db'); 
const methodOverride = require('method-override');
router.use(methodOverride('_method'));

// Listado
router.get('/', (req, res) => {
  db.all('SELECT * FROM instrumentos ORDER BY nombre', [], (err, instrumentos) => {
    if (err) return res.status(500).send('Error cargando instrumentos');
    res.render('instrumentos_lista', { instrumentos });
  });
});

// Formulario nuevo
router.get('/nuevo', (req, res) => {
  res.render('instrumentos_ficha', { instrumento: null });
});

//Formulario editar
router.get('/:id/editar', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM instrumentos WHERE id = ?', [id], (err, instrumento) => {
    if (err || !instrumento) return res.status(404).send('Instrumento no encontrado');
    res.render('instrumentos_ficha', { instrumento });
  });
});
// POST: Actualizar instrumentos
router.post('/editar/:id', (req, res) => {
  const id = req.params.id;
  const { nombre } = req.body;
  db.run('UPDATE instrumentos SET nombre = ? WHERE id = ?', [nombre, id], (err) => {
    if (err) return res.status(500).send('Error al actualizar instrumento');
    res.redirect('/instrumentos');
  });  
});

// Crear
router.post('/', (req, res) => {
  const { nombre } = req.body;
  db.run('INSERT INTO instrumentos (nombre) VALUES (?)', [nombre], err => {
    if (err) return res.status(500).send('Error al guardar');
    res.redirect('/instrumentos');
  });
});

// Actualizar
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  db.run('UPDATE instrumentos SET nombre = ? WHERE id = ?', [nombre, id], err => {
    if (err) return res.status(500).send('Error al actualizar');
    res.redirect('/instrumentos');
  });
});

// DELETE: Eliminar
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM instrumentos WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).send('Error al eliminar instrumento');
    }
    res.redirect('/instrumentos');
  });
});
module.exports = router;
