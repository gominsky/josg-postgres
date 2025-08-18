// routes/cuentas.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// Lista + búsqueda
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  const where = ['COALESCE(activo,true)=true'];
  if (q) { params.push(`%${q}%`); where.push('(nombre ILIKE $1)'); }

  try {
    const { rows } = await db.query(
      `SELECT id, nombre, activo
         FROM cuentas
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY lower(nombre) ASC`,
      params
    );
    res.render('cuentas_lista', { title:'Cuentas contables', hero:false, cuentas: rows, q });
  } catch (e) {
    console.error(e);
    res.render('cuentas_lista', { title:'Cuentas contables', hero:false, cuentas: [], q });
  }
});

// Nuevo (form)
router.get('/nuevo', (_req, res) => {
  res.render('cuentas_form', { title:'Nueva cuenta', hero:false, cuenta:null, EDIT:false });
});

// Nuevo (guardar)
router.post('/nuevo', async (req, res) => {
  const nombre = (req.body.nombre||'').trim();
  if (!nombre) return res.status(400).send('El nombre es obligatorio');
  try {
    await db.query(`INSERT INTO cuentas (nombre, activo) VALUES ($1, true)`, [nombre]);
    res.redirect('/cuentas?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo crear la cuenta');
  }
});

// Editar (form)
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM cuentas WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).send('Cuenta no encontrada');
    res.render('cuentas_form', { title:'Editar cuenta', hero:false, cuenta:rows[0], EDIT:true });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error al cargar la cuenta');
  }
});

// Editar (guardar)
router.post('/:id', async (req, res) => {
  const nombre = (req.body.nombre||'').trim();
  const activo = !!req.body.activo;
  if (!nombre) return res.status(400).send('El nombre es obligatorio');
  try {
    await db.query(`UPDATE cuentas SET nombre=$1, activo=$2 WHERE id=$3`, [nombre, activo, req.params.id]);
    res.redirect('/cuentas?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo actualizar la cuenta');
  }
});

// Eliminar (soft delete)
router.post('/:id/eliminar', async (req, res) => {
  try {
    await db.query(`UPDATE cuentas SET activo=false WHERE id=$1`, [req.params.id]);
    res.redirect('/cuentas?ok=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo eliminar');
  }
});

module.exports = router;
