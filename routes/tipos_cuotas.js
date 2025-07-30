const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Listado de tipos de cuota
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tipos_cuota ORDER BY tipo');
    res.render('tipos_cuotas_lista', {
      tipos_cuota: result.rows,
      hero: false
    });
  } catch (err) {
    console.error('❌ Error cargando tipos de cuota:', err.message);
    res.status(500).send('Error al cargar los tipos de cuota');
  }
});

// GET: Formulario nuevo tipo
router.get('/nueva', (req, res) => {
  res.render('tipos_cuotas_ficha', { tipo: null, hero: false });
});

// POST: Crear tipo
router.post('/', async (req, res) => {
  const { tipo } = req.body;
  try {
    await db.query('INSERT INTO tipos_cuota (tipo) VALUES ($1)', [tipo]);
    res.redirect('/tipos_cuotas');
  } catch (err) {
    console.error('❌ Error al guardar tipo de cuota:', err.message);
    res.status(500).send('Error al guardar tipo de cuota');
  }
});

// GET: Formulario edición
router.get('/editar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query('SELECT * FROM tipos_cuota WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Tipo de cuota no encontrado');
    res.render('tipos_cuotas_ficha', { tipo: result.rows[0], hero: false });
  } catch (err) {
    console.error('❌ Error consultando tipo de cuota:', err.message);
    res.status(500).send('Error al consultar el tipo de cuota');
  }
});

// POST: Actualizar tipo
router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { tipo } = req.body;
  try {
    await db.query('UPDATE tipos_cuota SET tipo = $1 WHERE id = $2', [tipo, id]);
    res.redirect('/tipos_cuotas');
  } catch (err) {
    console.error('❌ Error al actualizar tipo de cuota:', err.message);
    res.status(500).send('Error al actualizar tipo de cuota');
  }
});

// DELETE: Eliminar tipo
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM tipos_cuota WHERE id = $1', [id]);
    req.session.mensaje = 'Tipo de cuota eliminado';
  } catch (err) {
    console.error('❌ Error al eliminar tipo de cuota:', err.message);
    req.session.mensaje = 'No se pudo eliminar el tipo de cuota';
  }
  res.redirect('/tipos_cuotas');
});

module.exports = router;
