// routes/baremos.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Mostrar formulario de nuevo baremo
router.get('/nuevo', (req, res) => {
  res.render('baremos_ficha', { baremo: null });
});

// POST: Crear nuevo baremo
router.post('/', async (req, res) => {
  const { tipo, porcentaje } = req.body;

  try {
    await db.query(
      'INSERT INTO baremos (tipo, porcentaje) VALUES ($1, $2)',
      [tipo, porcentaje]
    );
    res.redirect('/baremos');
  } catch (err) {
    console.error('Error al guardar baremo:', err);
    res.status(500).send('Error al guardar el baremo');
  }
});

// GET: Listado de baremos con búsqueda + orden alfabético
router.get('/', async (req, res) => {
  const busqueda = (req.query.busqueda || '').trim();

  // Orden común (A→Z, case-insensitive)
  const ORDER = 'ORDER BY lower(tipo) ASC, id ASC';

  // Si hay búsqueda, filtramos y mantenemos el orden alfabético
  const sql = busqueda
    ? `SELECT * FROM baremos
       WHERE tipo ILIKE $1
          OR CAST(porcentaje AS TEXT) ILIKE $2
       ${ORDER}`
    : `SELECT * FROM baremos
       ${ORDER}`;

  const params = busqueda ? [`%${busqueda}%`, `%${busqueda}%`] : [];

  try {
    const result = await db.query(sql, params);
    res.render('baremos_lista', {
      baremos: result.rows,
      busqueda,
      hero: false
    });
  } catch (err) {
    console.error('Error al obtener baremos:', err);
    res.status(500).send('Error al obtener los baremos');
  }
});

// GET: Formulario de edición
router.get('/editar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const result = await db.query('SELECT * FROM baremos WHERE id = $1', [id]);
    const baremo = result.rows[0];

    if (!baremo) return res.status(404).send('Baremo no encontrado');
    res.render('baremos_ficha', { baremo });
  } catch (err) {
    console.error('Error al cargar baremo:', err);
    res.status(500).send('Error al cargar el baremo');
  }
});

// POST: Actualizar baremo
router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { tipo, porcentaje } = req.body;

  try {
    await db.query(
      'UPDATE baremos SET tipo = $1, porcentaje = $2 WHERE id = $3',
      [tipo, porcentaje, id]
    );
    res.redirect('/baremos');
  } catch (err) {
    console.error('Error al actualizar baremo:', err);
    res.status(500).send('Error al actualizar el baremo');
  }
});

// POST: Eliminar baremo (desde el formulario)
router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.query('DELETE FROM baremos WHERE id = $1', [id]);
    res.redirect('/baremos');
  } catch (err) {
    console.error('Error al eliminar baremo:', err);
    res.status(500).send('Error al eliminar el baremo');
  }
});

// DELETE: Eliminar baremo limpiando referencias en eventos.baremo_id y avisando
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('BEGIN');

    // 1) Quitar referencia en eventos
    const updEventos = await db.query(
      'UPDATE eventos SET baremo_id = NULL WHERE baremo_id = $1',
      [id]
    );

    // 2) Borrar el baremo
    const delB = await db.query('DELETE FROM baremos WHERE id = $1', [id]);

    await db.query('COMMIT');

    const msg = delB.rowCount
      ? `Baremo borrado. Eventos actualizados: ${updEventos.rowCount}.`
      : 'El baremo no existía (0 filas).';

    return res.redirect(`/baremos?notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    console.error('Error al eliminar baremo:', err);
    await db.query('ROLLBACK');
    const warn = 'No se pudo borrar el baremo. Revisa relaciones o permisos.';
    return res.redirect(`/baremos?warning=${encodeURIComponent(warn)}`);
  }
});

module.exports = router;
