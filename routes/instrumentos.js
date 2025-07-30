const express = require('express');
const router = express.Router();
const db = require('../database/db');
const methodOverride = require('method-override');
router.use(methodOverride('_method'));

const FAMILIAS = [
  'Cuerda',
  'Percusión',
  'Viento madera',
  'Viento metal',
  'Otra'
];

// GET: Listado de instrumentos
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM instrumentos ORDER BY nombre');
    res.render('instrumentos_lista', { instrumentos: result.rows });
  } catch (err) {
    console.error('❌ Error cargando instrumentos:', err.message);
    res.status(500).send('Error cargando instrumentos');
  }
});

// GET: Formulario para nuevo instrumento
router.get('/nuevo', (req, res) => {
  res.render('instrumentos_ficha', { instrumento: null, familias: FAMILIAS });
});

// GET: Formulario para editar instrumento
router.get('/:id/editar', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query('SELECT * FROM instrumentos WHERE id = $1', [id]);
    const instrumento = result.rows[0];
    if (!instrumento) return res.status(404).send('Instrumento no encontrado');
    res.render('instrumentos_ficha', { instrumento, familias: FAMILIAS });
  } catch (err) {
    console.error('❌ Error al obtener instrumento:', err.message);
    res.status(500).send('Error al cargar instrumento');
  }
});

// POST: Crear nuevo instrumento
router.post('/', async (req, res) => {
  const { nombre, familia } = req.body;
  try {
    await db.query('INSERT INTO instrumentos (nombre, familia) VALUES ($1, $2)', [nombre, familia]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al guardar instrumento:', err.message);
    res.status(500).send('Error al guardar instrumento');
  }
});

// POST: Actualizar instrumento (desde formulario)
router.post('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, familia } = req.body;
  try {
    await db.query('UPDATE instrumentos SET nombre = $1, familia = $2 WHERE id = $3', [nombre, familia, id]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al actualizar instrumento:', err.message);
    res.status(500).send('Error al actualizar instrumento');
  }
});

// PUT: Actualizar instrumento (RESTful)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, familia } = req.body;
  try {
    await db.query('UPDATE instrumentos SET nombre = $1, familia = $2 WHERE id = $3', [nombre, familia, id]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al actualizar instrumento:', err.message);
    res.status(500).send('Error al actualizar instrumento');
  }
});

// DELETE: Eliminar instrumento
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM instrumentos WHERE id = $1', [id]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al eliminar instrumento:', err.message);
    res.status(500).send('Error al eliminar instrumento');
  }
});

module.exports = router;
