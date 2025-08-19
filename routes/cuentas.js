// routes/cuentas.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// routes/cuentas.js
router.get('/', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, nombre, tipo, iban, saldo_inicial, fecha_saldo, activo
      FROM cuentas
      ORDER BY lower(nombre) ASC
    `);

    res.render('cuentas_lista', {
      title: 'Cuentas contables',
      hero: false,
      cuentas: rows
    });
  } catch (e) {
    console.error(e);
    res.render('cuentas_lista', { title: 'Cuentas contables', hero:false, cuentas: [] });
  }
});

// Nuevo (form)
router.get('/nuevo', (_req, res) => {
  res.render('cuentas_form', { title:'Nueva cuenta', hero:false, cuenta:null, EDIT:false });
});

// Crear
router.post('/nuevo', async (req, res) => {
  try {
    const nombre = (req.body.nombre || '').trim();

    let tipo = (req.body.tipo ?? 'banco').toString().trim().toLowerCase();
    if (!['banco','caja'].includes(tipo)) tipo = 'banco';

    const iban = (req.body.iban || '').trim() || null;
    const saldo_inicial = req.body.saldo_inicial ? Number(req.body.saldo_inicial) : 0;
    const fecha_saldo   = req.body.fecha_saldo || null;

    if (!nombre) return res.status(400).send('Falta el nombre');

    await db.query(
      `INSERT INTO cuentas (nombre, tipo, iban, saldo_inicial, fecha_saldo, activo)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [nombre, tipo, iban, saldo_inicial, fecha_saldo]
    );

    // 👇 volver al listado
    res.redirect('/cuentas?ok=1');
  } catch (e) {
    console.error(e);
    res.redirect('/cuentas/nuevo');
  }
});

// Actualizar
router.post('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send('Cuenta no encontrada');

    const nombre = (req.body.nombre || '').trim();

    let tipo = (req.body.tipo ?? 'banco').toString().trim().toLowerCase();
    if (!['banco','caja'].includes(tipo)) tipo = 'banco';

    const iban = (req.body.iban || '').trim() || null;
    const saldo_inicial = req.body.saldo_inicial ? Number(req.body.saldo_inicial) : 0;
    const fecha_saldo   = req.body.fecha_saldo || null;
    const activo        = req.body.activo !== undefined; // checkbox

    if (!nombre) return res.status(400).send('Falta el nombre');

    await db.query(
      `UPDATE cuentas
         SET nombre=$1, tipo=$2, iban=$3, saldo_inicial=$4, fecha_saldo=$5, activo=$6
       WHERE id=$7`,
      [nombre, tipo, iban, saldo_inicial, fecha_saldo, activo, id]
    );

    // 👇 volver al listado (en lugar de /cuentas/:id)
    res.redirect('/cuentas?ok=1');
  } catch (e) {
    console.error(e);
    res.redirect('/cuentas');
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
