// routes/categorias.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// Lista + búsqueda
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  const where = ['COALESCE(activo,true)=true'];
  if (q) { params.push(`%${q}%`); where.push('(nombre ILIKE $1 OR descripcion ILIKE $1)'); }

  try {
    const { rows } = await db.query(
      `SELECT id, nombre, descripcion, activo
         FROM categorias_gasto
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY lower(nombre) ASC`,
      params
    );
    res.render('categorias_lista', { title: 'Categorías de gasto', hero:false, categorias: rows, q });
  } catch (e) {
    console.error(e);
    res.render('categorias_lista', { title: 'Categorías de gasto', hero:false, categorias: [], q });
  }
});

// Nuevo (form)
router.get('/nuevo', (_req, res) => {
  res.render('categorias_form', { title: 'Nueva categoría', hero:false, cat: null, EDIT:false });
});

// Nuevo (guardar)
router.post('/nuevo', async (req, res) => {
  const nombre = (req.body.nombre||'').trim();
  const descripcion = (req.body.descripcion||'').trim();
  if (!nombre) return res.status(400).send('El nombre es obligatorio');
  try {
    await db.query(`INSERT INTO categorias_gasto (nombre, descripcion, activo) VALUES ($1,$2,true)`, [nombre, descripcion]);
    res.redirect('/categorias?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo crear la categoría');
  }
});

// Editar (form)
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM categorias_gasto WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).send('Categoría no encontrada');
    res.render('categorias_form', { title:'Editar categoría', hero:false, cat: rows[0], EDIT:true });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error al cargar la categoría');
  }
});

// Editar (guardar)
router.post('/:id', async (req, res) => {
  const nombre = (req.body.nombre||'').trim();
  const descripcion = (req.body.descripcion||'').trim();
  const activo = !!req.body.activo;
  if (!nombre) return res.status(400).send('El nombre es obligatorio');
  try {
    await db.query(`UPDATE categorias_gasto SET nombre=$1, descripcion=$2, activo=$3 WHERE id=$4`,
      [nombre, descripcion, activo, req.params.id]);
    res.redirect('/categorias?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo actualizar la categoría');
  }
});

// Eliminar (soft delete)
router.post('/:id/eliminar', async (req, res) => {
  try {
    await db.query(`UPDATE categorias_gasto SET activo=false WHERE id=$1`, [req.params.id]);
    res.redirect('/categorias?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo eliminar');
  }
});

module.exports = router;
