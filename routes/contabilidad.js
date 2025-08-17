const express = require('express');
const router = express.Router();
const db = require('../database/db');

// ===== Menú de contabilidad =====
router.get('/contabilidad', (req, res) => {
  res.render('contabilidad_menu', { title: 'Contabilidad', hero: false });
});

// ===== Listado de facturas =====
router.get('/facturas', async (req, res) => {
  try {
    const { proveedor, estado, desde, hasta } = req.query;
    const where = [];
    const params = [];

    if (proveedor) { params.push(proveedor); where.push(`proveedor_id = $${params.length}`); }
    if (estado)    { params.push(estado);    where.push(`estado_calc = $${params.length}`); }
    if (desde)     { params.push(desde);     where.push(`fecha_emision >= $${params.length}`); }
    if (hasta)     { params.push(hasta);     where.push(`fecha_emision <= $${params.length}`); }

    const sql = `
      SELECT f.*, pr.nombre AS proveedor, cg.nombre AS categoria
      FROM v_facturas_prov_saldos f
      JOIN proveedores pr      ON pr.id = f.proveedor_id
      LEFT JOIN categorias_gasto cg ON cg.id = f.categoria_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY fecha_emision DESC, id DESC
    `;
    const { rows } = await db.query(sql, params);
    const proveedores = (await db.query('SELECT id, nombre FROM proveedores WHERE activo = TRUE ORDER BY nombre')).rows;

    res.render('facturas_lista', {
      title: 'Facturas', hero: false,
      facturas: rows, proveedores, filtros: req.query
    });
  } catch (e) {
    console.error(e);
    res.render('facturas_lista', { title: 'Facturas', hero: false, facturas: [], proveedores: [], filtros: {} });
  }
});

// ===== Nueva factura =====
router.get('/facturas/nueva', async (req, res) => {
  const [provs, cats, cuentas] = await Promise.all([
    db.query('SELECT id, nombre FROM proveedores WHERE activo=TRUE ORDER BY nombre'),
    db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
    db.query('SELECT id, nombre FROM cuentas WHERE activo=TRUE ORDER BY nombre')
  ]);
  res.render('facturas_form', {
    title: 'Nueva factura', hero: false, factura: null,
    proveedores: provs.rows, categorias: cats.rows, cuentas: cuentas.rows
  });
});

router.post('/facturas', async (req, res) => {
  const {
    proveedor_id, categoria_id, cuenta_id,
    numero, fecha_emision, fecha_vencimiento,
    concepto, base_imponible, iva_pct, total, notas
  } = req.body;

  await db.query(`
    INSERT INTO facturas_prov
      (proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_vencimiento,
       concepto, base_imponible, iva_pct, total, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [
    proveedor_id || null, categoria_id || null, cuenta_id || null,
    numero, fecha_emision, fecha_vencimiento || null, concepto || null,
    base_imponible || 0, iva_pct || 21, total, notas || null
  ]);

  res.redirect('/facturas');
});

// ===== Editar factura + pagos =====
router.get('/facturas/:id', async (req, res) => {
  const id = req.params.id;
  const factura = (await db.query('SELECT * FROM v_facturas_prov_saldos WHERE id=$1', [id])).rows[0];
  if (!factura) return res.redirect('/facturas');

  const [provs, cats, cuentas, pagos] = await Promise.all([
    db.query('SELECT id, nombre FROM proveedores WHERE activo=TRUE ORDER BY nombre'),
    db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
    db.query('SELECT id, nombre FROM cuentas WHERE activo=TRUE ORDER BY nombre'),
    db.query('SELECT p.*, c.nombre AS cuenta FROM pagos p JOIN cuentas c ON c.id=p.cuenta_id WHERE factura_id=$1 ORDER BY fecha', [id])
  ]);

  res.render('facturas_form', {
    title: 'Editar factura', hero: false,
    factura, proveedores: provs.rows, categorias: cats.rows, cuentas: cuentas.rows, pagos: pagos.rows
  });
});

router.post('/facturas/:id', async (req, res) => {
  const id = req.params.id;
  const {
    proveedor_id, categoria_id, cuenta_id,
    numero, fecha_emision, fecha_vencimiento,
    concepto, base_imponible, iva_pct, total, estado, notas
  } = req.body;

  await db.query(`
    UPDATE facturas_prov
    SET proveedor_id=$1, categoria_id=$2, cuenta_id=$3, numero=$4, fecha_emision=$5,
        fecha_vencimiento=$6, concepto=$7, base_imponible=$8, iva_pct=$9, total=$10,
        estado=$11, notas=$12, updated_at=NOW()
    WHERE id=$13
  `, [
    proveedor_id || null, categoria_id || null, cuenta_id || null, numero,
    fecha_emision, fecha_vencimiento || null, concepto || null,
    base_imponible || 0, iva_pct || 21, total, estado || 'pendiente', notas || null, id
  ]);

  res.redirect('/facturas/' + id);
});

router.post('/facturas/:id/eliminar', async (req, res) => {
  await db.query('DELETE FROM facturas_prov WHERE id=$1', [req.params.id]);
  res.redirect('/facturas');
});

// ===== Pagos =====
router.post('/pagos', async (req, res) => {
  const { factura_id, cuenta_id, fecha, importe, metodo, referencia, notas } = req.body;
  await db.query(`
    INSERT INTO pagos (factura_id, cuenta_id, fecha, importe, metodo, referencia, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [factura_id, cuenta_id, fecha, importe, metodo, referencia || null, notas || null]);
  res.redirect('/facturas/' + factura_id);
});

router.post('/pagos/:id/eliminar', async (req, res) => {
  const pago = (await db.query('SELECT factura_id FROM pagos WHERE id=$1', [req.params.id])).rows[0];
  await db.query('DELETE FROM pagos WHERE id=$1', [req.params.id]);
  res.redirect('/facturas/' + pago.factura_id);
});

module.exports = router;
