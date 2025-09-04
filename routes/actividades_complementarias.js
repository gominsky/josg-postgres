const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Formulario de nueva actividad complementaria
router.get('/nuevo', (_req, res) => {
  res.render('actividades_complementarias_ficha', { item: null });
});

// POST: Crear
router.post('/', async (req, res) => {
  const { tipo, descripcion } = req.body;
  try {
    await db.query(
      'INSERT INTO actividades_complementarias (tipo, descripcion) VALUES ($1, $2)',
      [tipo, descripcion]
    );
    res.redirect('/actividades');
  } catch (err) {
    console.error('Error al guardar actividad:', err);
    res.status(500).send('Error al guardar la actividad complementaria');
  }
});

// GET: Listado con búsqueda + orden alfabético
router.get('/', async (req, res) => {
  const busqueda = (req.query.busqueda || '').trim();
  const ORDER = 'ORDER BY lower(tipo) ASC, id ASC';

  const sql = busqueda
    ? `SELECT * FROM actividades_complementarias WHERE tipo ILIKE $1 OR descripcion ILIKE $2 ${ORDER}`
    : `SELECT * FROM actividades_complementarias ${ORDER}`;

  const params = busqueda ? [`%${busqueda}%`, `%${busqueda}%`] : [];

  try {
    const result = await db.query(sql, params);
    res.render('actividades_complementarias_lista', { items: result.rows, busqueda, hero: false });
  } catch (err) {
    console.error('Error al obtener actividades complementarias:', err);
    res.status(500).send('Error al obtener actividades complementarias');
  }
});

// GET: Formulario de edición
router.get('/editar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query('SELECT * FROM actividades_complementarias WHERE id = $1', [id]);
    const item = result.rows[0];
    if (!item) return res.status(404).send('Actividad complementaria no encontrada');
    res.render('actividades_complementarias_ficha', { item });
  } catch (err) {
    console.error('Error al cargar actividad complementaria:', err);
    res.status(500).send('Error al cargar actividad complementaria');
  }
});

// POST: Actualizar
router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { tipo, descripcion } = req.body;
  try {
    await db.query(
      'UPDATE actividades_complementarias SET tipo = $1, descripcion = $2 WHERE id = $3',
      [tipo, descripcion, id]
    );
    res.redirect('/actividades');
  } catch (err) {
    console.error('Error al actualizar actividad complementaria:', err);
    res.status(500).send('Error al actualizar actividad complementaria');
  }
});

// POST: Eliminar
router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM actividades_complementarias WHERE id = $1', [id]);
    res.redirect('/actividades');
  } catch (err) {
    console.error('Error al eliminar actividad complementaria:', err);
    res.status(500).send('Error al eliminar actividad complementaria');
  }
});

// DELETE (REST)
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM actividades_complementarias WHERE id = $1', [id]);
    res.redirect('/actividades');
  } catch (err) {
    console.error('Error al eliminar actividad complementaria:', err);
    res.status(500).send('Error al eliminar actividad complementaria');
  }
});

module.exports = router;