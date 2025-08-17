// routes/contabilidad.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

/* ===================== Helpers ===================== */

// Proveedores para selects
async function getProveedores() {
  const { rows } = await db.query(
    `SELECT id, nombre, nif_cif AS cif
       FROM proveedores
      WHERE COALESCE(activo,true)=true
      ORDER BY nombre ASC`
  );
  return rows;
}

// Listado base (ultimas) con alias base/iva desde facturas_prov
const LISTADO_SQL = `
  SELECT
    f.id, f.numero, f.fecha_emision, f.fecha_vencimiento,
    f.base_imponible AS base,
    ROUND(f.base_imponible * (f.iva_pct/100.0), 2) AS iva,
    f.total,
    p.nombre AS proveedor
  FROM facturas_prov f
  LEFT JOIN proveedores p ON p.id = f.proveedor_id
  ORDER BY f.fecha_emision DESC NULLS LAST, f.id DESC
  LIMIT 12
`;

/* ===================== Rutas ===================== */

// Menú principal (muestra últimas)
router.get('/', async (req, res) => {
  try {
    const ult = await db.query(LISTADO_SQL);
    res.render('contabilidad_menu', {
      title: 'Contabilidad',
      hero: false,
      ultimas: ult.rows || []
    });
  } catch (e) {
    console.error(e);
    res.render('contabilidad_menu', {
      title: 'Contabilidad',
      hero: false,
      ultimas: []
    });
  }
});

// Ayuda
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_contabilidad', { title: 'Ayuda · Contabilidad', hero: false });
});

// LISTADO con filtros
router.get('/facturas', async (req, res) => {
  const { desde = '', hasta = '', proveedor = '', q = '', ordenar = 'fecha_emision_desc' } = req.query;

  const where = [];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (desde)    where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date >= ${push(desde)})`);
  if (hasta)    where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date <= ${push(hasta)})`);
  if (proveedor) where.push(`f.proveedor_id = ${push(proveedor)}`);
  if (q) {
    const p = `%${q}%`;
    // 👇 sin factura_lineas: buscamos por nº, proveedor o concepto de la factura
    where.push(`(f.numero ILIKE ${push(p)} OR p.nombre ILIKE ${push(p)} OR f.concepto ILIKE ${push(p)})`);
  }

  let orderBy = `f.fecha_emision DESC, f.id DESC`;
  if (ordenar === 'fecha_emision_asc') orderBy = `f.fecha_emision ASC, f.id ASC`;
  if (ordenar === 'proveedor_asc')     orderBy = `p.nombre ASC, f.fecha_emision DESC`;
  if (ordenar === 'proveedor_desc')    orderBy = `p.nombre DESC, f.fecha_emision DESC`;
  if (ordenar === 'total_desc')        orderBy = `f.total DESC NULLS LAST`;
  if (ordenar === 'total_asc')         orderBy = `f.total ASC NULLS FIRST`;

  try {
    const proveedores = await getProveedores();

    const sql = `
      SELECT
        f.id, f.numero, f.fecha_emision, f.fecha_vencimiento,
        f.base_imponible AS base,
        ROUND(f.base_imponible * (f.iva_pct/100.0), 2) AS iva,
        f.total,
        p.nombre AS proveedor,
        CASE 
          WHEN f.fecha_vencimiento IS NOT NULL
           AND f.fecha_vencimiento::date < CURRENT_DATE THEN 'Vencida'
          ELSE 'Emitida'
        END AS estado
      FROM facturas_prov f
      LEFT JOIN proveedores p ON p.id = f.proveedor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderBy}
      LIMIT 500
    `;
    const { rows } = await db.query(sql, params);

    // Totales
    const totSQL = `
      SELECT
        COALESCE(SUM(f.total),0)           AS suma_total,
        COALESCE(SUM(f.base_imponible),0)  AS suma_base,
        COUNT(*)                            AS n
      FROM facturas_prov f
      LEFT JOIN proveedores p ON p.id = f.proveedor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    const { rows: tot } = await db.query(totSQL, params);

    res.render('facturas_lista', {
      title: 'Facturas',
      hero: false,
      proveedores,
      facturas: rows || [],
      resumen: tot[0] || { suma_total: 0, suma_base: 0, n: 0 },
      filtros: { desde, hasta, proveedor, q, ordenar }
    });
  } catch (e) {
    console.error(e);
    res.render('facturas_lista', {
      title: 'Facturas',
      hero: false,
      proveedores: [],
      facturas: [],
      resumen: { suma_total: 0, suma_base: 0, n: 0 },
      filtros: { desde, hasta, proveedor, q, ordenar }
    });
  }
});

// NUEVA
router.get('/facturas/nueva', async (_req, res) => {
  const [proveedores, categorias, cuentas] = await Promise.all([
    db.query('SELECT id, nombre FROM proveedores ORDER BY nombre'),
    db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
    // 👇 fuera el filtro "activa = TRUE" (tu esquema no tiene esa columna)
    db.query('SELECT id, nombre FROM cuentas ORDER BY nombre'),
  ]);

  res.render('facturas_form', {
    title: 'Nueva factura',
    factura: null,
    proveedores: proveedores.rows,
    categorias: categorias.rows,
    cuentas: cuentas.rows,
    lineas: [], // UI de líneas opcional (no se persiste en este esquema)
    EDIT: false
  });
});

// EDITAR
router.get('/facturas/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).send('Factura no encontrada');

  const { rows } = await db.query(`
    SELECT f.*, p.nombre AS proveedor_nombre, c.nombre AS categoria_nombre, ct.nombre AS cuenta_nombre
    FROM facturas_prov f
    LEFT JOIN proveedores p      ON p.id  = f.proveedor_id
    LEFT JOIN categorias_gasto c ON c.id  = f.categoria_id
    LEFT JOIN cuentas ct         ON ct.id = f.cuenta_id
    WHERE f.id = $1
  `, [id]);
  if (!rows.length) return res.status(404).send('Factura no encontrada');

  const [proveedores, categorias, cuentas] = await Promise.all([
    db.query('SELECT id, nombre FROM proveedores ORDER BY nombre'),
    db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
    db.query('SELECT id, nombre FROM cuentas ORDER BY nombre'),
  ]);

  res.render('facturas_form', {
    title: 'Editar factura',
    factura: rows[0],
    proveedores: proveedores.rows,
    categorias: categorias.rows,
    cuentas: cuentas.rows,
    lineas: [], // UI de líneas opcional
    EDIT: true
  });
});

// CREAR/ACTUALIZAR (unificado)
router.post('/facturas/guardar', async (req, res) => {
  try {
    const id              = req.body.id ? Number(req.body.id) : null;
    let   proveedor_id    = req.body.proveedor_id ? Number(req.body.proveedor_id) : null;
    const proveedor_nombre= (req.body.proveedor_nombre||'').trim();
    const proveedor_cif   = (req.body.proveedor_cif||'').trim() || null;

    // Alta rápida de proveedor si no se eligió uno
    if (!proveedor_id && proveedor_nombre) {
      const insP = await db.query(
        `INSERT INTO proveedores(nombre, nif_cif, activo) VALUES ($1,$2,true) RETURNING id`,
        [proveedor_nombre, proveedor_cif]
      );
      proveedor_id = insP.rows[0].id;
    }

    const categoria_id    = req.body.categoria_id ? Number(req.body.categoria_id) : null;
    const cuenta_id       = req.body.cuenta_id ? Number(req.body.cuenta_id) : null;
    const numero          = (req.body.numero || '').trim();
    const fecha_emision   = req.body.fecha_emision || null;
    const fecha_venc      = req.body.fecha_vencimiento || null;
    const concepto        = (req.body.concepto || '').trim();
    const base_imponible  = Number(req.body.base_imponible || 0);
    const iva_pct         = Number(req.body.iva_pct || 21);
    const total           = req.body.total ? Number(req.body.total)
                                           : +(base_imponible * (1 + iva_pct/100)).toFixed(2);
    const estado          = (req.body.estado || 'pendiente').trim();
    const notas           = (req.body.notas || '').trim();
    const observaciones   = (req.body.observaciones || '').trim();

    if (!proveedor_id || !numero || !fecha_emision) {
      return res.status(400).send('Faltan datos obligatorios');
    }

    if (id) {
      await db.query(`
        UPDATE facturas_prov
           SET proveedor_id=$1, categoria_id=$2, cuenta_id=$3, numero=$4,
               fecha_emision=$5, fecha_vencimiento=$6, concepto=$7,
               base_imponible=$8, iva_pct=$9, total=$10, estado=$11, notas=$12, observaciones=$13
         WHERE id=$14
      `, [proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_venc, concepto,
          base_imponible, iva_pct, total, estado, notas, observaciones, id]);
      return res.redirect(`/contabilidad/facturas/${id}?ok=1`);
    } else {
      const ins = await db.query(`
        INSERT INTO facturas_prov
          (proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_vencimiento,
           concepto, base_imponible, iva_pct, total, estado, notas, observaciones)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id
      `, [proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_venc, concepto,
          base_imponible, iva_pct, total, estado, notas, observaciones]);
      return res.redirect(`/contabilidad/facturas/${ins.rows[0].id}?ok=1`);
    }
  } catch (e) {
    console.error(e);
    return res.redirect('/contabilidad/facturas/nueva');
  }
});

// ELIMINAR (sólo facturas_prov)
router.post('/facturas/:id/eliminar', async (req, res) => {
  try {
    await db.query(`DELETE FROM facturas_prov WHERE id = $1`, [req.params.id]);
    res.redirect('/contabilidad?ok=1');
  } catch (e) {
    console.error(e);
    res.redirect(`/contabilidad/facturas/${req.params.id}`);
  }
});

module.exports = router;
