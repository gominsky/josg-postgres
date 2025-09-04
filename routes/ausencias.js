
const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Mostrar formulario de nueva ausencia
router.get('/nuevo', (_req, res) => {
  res.render('ausencias_ficha', { item: null });
});

// POST: Crear nueva ausencia
router.post('/', async (req, res) => {
  const { tipo } = req.body;
  try {
    await db.query('INSERT INTO ausencias (tipo) VALUES ($1)', [tipo]);
    res.redirect('/ausencias');
  } catch (err) {
    console.error('Error al guardar ausencia:', err);
    res.status(500).send('Error al guardar la ausencia');
  }
});

// GET: Listado de ausencias con búsqueda + orden alfabético
router.get('/', async (req, res) => {
  const busqueda = (req.query.busqueda || '').trim();
  const ORDER = 'ORDER BY lower(tipo) ASC, id ASC';

  const sql = busqueda
    ? `SELECT * FROM ausencias WHERE tipo ILIKE $1 ${ORDER}`
    : `SELECT * FROM ausencias ${ORDER}`;

  const params = busqueda ? [`%${busqueda}%`] : [];

  try {
    const result = await db.query(sql, params);
    res.render('ausencias_lista', { items: result.rows, busqueda, hero: false });
  } catch (err) {
    console.error('Error al obtener ausencias:', err);
    res.status(500).send('Error al obtener ausencias');
  }
});

// GET: Formulario de edición
router.get('/editar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query('SELECT * FROM ausencias WHERE id = $1', [id]);
    const item = result.rows[0];
    if (!item) return res.status(404).send('Ausencia no encontrada');
    res.render('ausencias_ficha', { item });
  } catch (err) {
    console.error('Error al cargar ausencia:', err);
    res.status(500).send('Error al cargar ausencia');
  }
});

// POST: Actualizar
router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { tipo } = req.body;
  try {
    await db.query('UPDATE ausencias SET tipo = $1 WHERE id = $2', [tipo, id]);
    res.redirect('/ausencias');
  } catch (err) {
    console.error('Error al actualizar ausencia:', err);
    res.status(500).send('Error al actualizar ausencia');
  }
});

// POST: Eliminar
router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM ausencias WHERE id = $1', [id]);
    res.redirect('/ausencias');
  } catch (err) {
    console.error('Error al eliminar ausencia:', err);
    res.status(500).send('Error al eliminar ausencia');
  }
});

// DELETE (REST)
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM ausencias WHERE id = $1', [id]);
    res.redirect('/ausencias');
  } catch (err) {
    console.error('Error al eliminar ausencia:', err);
    res.status(500).send('Error al eliminar ausencia');
  }
});

module.exports = router;
