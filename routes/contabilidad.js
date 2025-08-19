// routes/contabilidad.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

/* ===================== Uploads de facturas (PDF/Imagen) ===================== */
const uploadsDir = path.join(__dirname, '..', 'uploads', 'facturas');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const fileFilter = (_req, file, cb) => {
  const ok = /pdf|jpeg|jpg|png|webp/i.test(file.mimetype);
  cb(ok ? null : new Error('Formato no permitido (PDF/JPG/PNG/WEBP)'), ok);
};
const upload = multer({
  storage, fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/* ===================== Helpers ===================== */

// Proveedores para selects
async function getProveedores() {
  const { rows } = await db.query(
    `SELECT id, nombre, cif AS cif
       FROM proveedores
      WHERE COALESCE(activo,true)=true
      ORDER BY nombre ASC`
  );
  return rows;
}

// Factura + pagado/saldo
async function getFactura(id) {
  const { rows } = await db.query(`
    SELECT f.*,
           p.nombre AS proveedor_nombre,
           c.nombre AS categoria_nombre,
           ct.nombre AS cuenta_nombre,
           COALESCE(v.pagado,0) AS pagado,
           GREATEST(f.total - COALESCE(v.pagado,0), 0)::NUMERIC(12,2) AS saldo
      FROM facturas_prov f
      LEFT JOIN proveedores      p  ON p.id  = f.proveedor_id
      LEFT JOIN categorias_gasto c  ON c.id  = f.categoria_id
      LEFT JOIN cuentas          ct ON ct.id = f.cuenta_id
      LEFT JOIN v_factura_sumas_pagos v ON v.factura_id = f.id
     WHERE f.id = $1
  `, [id]);
  return rows[0];
}

async function getAdjuntosFactura(id) {
  const { rows } = await db.query(
    `SELECT * FROM factura_adjuntos WHERE factura_id=$1 ORDER BY uploaded_at DESC`, [id]
  );
  return rows;
}

async function getPagosFactura(id) {
  const { rows } = await db.query(
    `SELECT a.id, a.importe_aplicado, pr.fecha, pr.metodo, pr.referencia, pr.id AS pago_id
       FROM pagos_prov_aplicaciones a
       JOIN pagos_prov pr ON pr.id = a.pago_id
      WHERE a.factura_id=$1
      ORDER BY pr.fecha DESC, a.id DESC`, [id]
  );
  return rows;
}

// Recalcular estado por pagos/importe
async function recalcularEstadoFactura(facturaId) {
  const { rows } = await db.query(
    `SELECT f.total, f.estado,
            COALESCE(v.pagado,0) AS pagado
       FROM facturas_prov f
       LEFT JOIN v_factura_sumas_pagos v ON v.factura_id = f.id
      WHERE f.id=$1`, [facturaId]);
  if (!rows.length) return;

  const { total, estado: actual, pagado } = rows[0];
  let nuevo = actual;

  if (actual === 'anulada') {
    nuevo = 'anulada';
  } else if (total == null || isNaN(total)) {
    nuevo = 'borrador';
  } else if (pagado <= 0) {
    nuevo = 'pendiente';
  } else if (pagado < total) {
    nuevo = 'parcial';
  } else {
    nuevo = 'pagada';
  }

  if (nuevo !== actual) {
    await db.query(`UPDATE facturas_prov SET estado=$1 WHERE id=$2`, [nuevo, facturaId]);
  }
}

/* ===================== Listado base (últimas) ===================== */
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

function csvEscape(v='') {
  const s = String(v ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function sendCSV(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const lines = [];
  lines.push('sep=,'); // hint para Excel
  lines.push(header.map(csvEscape).join(','));
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  res.send(lines.join('\n'));
}
// facturas pendientes (saldo > 0) de un proveedor
async function getFacturasPendientesProveedor(proveedorId) {
  const { rows } = await db.query(`
    SELECT f.id, f.numero, f.fecha_emision, f.fecha_vencimiento, f.total,
           COALESCE(v.pagado,0) AS pagado,
           GREATEST(f.total - COALESCE(v.pagado,0), 0)::NUMERIC(12,2) AS saldo
      FROM facturas_prov f
      LEFT JOIN v_factura_sumas_pagos v ON v.factura_id = f.id
     WHERE f.proveedor_id = $1
       AND COALESCE(f.estado,'pendiente') NOT IN ('pagada','anulada')
       AND (f.total IS NOT NULL)
     ORDER BY f.fecha_vencimiento NULLS LAST, f.fecha_emision DESC
  `, [proveedorId]);
  return rows.filter(r => Number(r.saldo) > 0); // robustez
}
// Recalcula estado de una factura en base a lo pagado
async function recalcularEstadoFactura(facturaId) {
  const { rows } = await db.query(`
    SELECT f.estado, f.total, COALESCE(v.pagado,0) AS pagado
    FROM facturas_prov f
    LEFT JOIN v_factura_sumas_pagos v ON v.factura_id = f.id
    WHERE f.id = $1
  `, [facturaId]);

  if (!rows.length) return;

  const cur = (rows[0].estado || 'pendiente').toLowerCase();
  const total  = Number(rows[0].total || 0);
  const pagado = Number(rows[0].pagado || 0);
  const eps = 0.009;

  // Mantener "anulada" si ya lo está
  if (cur === 'anulada') return;

  let nuevo = 'pendiente';
  if (pagado > eps && pagado + eps < total) nuevo = 'parcial';
  if (Math.abs(pagado - total) <= eps)      nuevo = 'pagada';

  if (nuevo !== cur) {
    await db.query(`UPDATE facturas_prov SET estado=$1 WHERE id=$2`, [nuevo, facturaId]);
  }
}
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

// LISTADO con filtros (añadimos estado y vencimiento)
router.get('/facturas', async (req, res) => {
  const {
    desde = '', hasta = '', proveedor = '', q = '',
    ordenar = 'fecha_emision_desc', estado = '', venc = '',
    page:pageQ = '1', per_page:ppQ = '50'
  } = req.query;

  const page = Math.max(1, parseInt(pageQ,10) || 1);
  const per_page = Math.min(200, Math.max(10, parseInt(ppQ,10) || 50));
  const offset = (page - 1) * per_page;

  const where = [];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (desde)     where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date >= ${push(desde)})`);
  if (hasta)     where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date <= ${push(hasta)})`);
  if (proveedor) where.push(`f.proveedor_id = ${push(proveedor)}`);
  if (estado)    where.push(`f.estado = ${push(estado)}`);
  if (q) {
    const p = `%${q}%`;
    where.push(`(f.numero ILIKE ${push(p)} OR p.nombre ILIKE ${push(p)} OR f.concepto ILIKE ${push(p)})`);
  }
  if (venc) {
    if (['7','15','30'].includes(venc)) {
      where.push(`(f.fecha_vencimiento IS NOT NULL AND f.fecha_vencimiento::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '${venc} days'))`);
    } else if (venc === 'vencida') {
      where.push(`(f.fecha_vencimiento IS NOT NULL AND f.fecha_vencimiento::date < CURRENT_DATE AND f.estado <> 'pagada')`);
    }
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
        f.estado
      FROM facturas_prov f
      LEFT JOIN proveedores p ON p.id = f.proveedor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderBy}
      LIMIT ${per_page} OFFSET ${offset}
    `;
    const { rows } = await db.query(sql, params);

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
    const total = Number(tot[0]?.n || 0);
    const total_pages = Math.max(1, Math.ceil(total / per_page));

    res.render('facturas_lista', {
      title: 'Facturas',
      hero: false,
      proveedores,
      facturas: rows || [],
      resumen: tot[0] || { suma_total: 0, suma_base: 0, n: 0 },
      filtros: { desde, hasta, proveedor, q, ordenar, estado, venc },
      paginacion: { page, per_page, total_pages }
    });
  } catch (e) {
    console.error(e);
    res.render('facturas_lista', {
      title: 'Facturas',
      hero: false,
      proveedores: [],
      facturas: [],
      resumen: { suma_total: 0, suma_base: 0, n: 0 },
      filtros: { desde, hasta, proveedor, q, ordenar, estado, venc },
      paginacion: { page:1, per_page:50, total_pages:1 }
    });
  }
});

// NUEVA
router.get('/facturas/nueva', async (_req, res) => {
  const [proveedores, categorias, cuentas] = await Promise.all([
    db.query('SELECT id, nombre FROM proveedores ORDER BY nombre'),
    db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
    db.query('SELECT id, nombre FROM cuentas ORDER BY nombre'),
  ]);

  res.render('facturas_form', {
    title: 'Nueva factura',
    factura: null,
    proveedores: proveedores.rows,
    categorias: categorias.rows,
    cuentas: cuentas.rows,
    lineas: [],
    EDIT: false
  });
});

// EDITAR (con adjuntos + pagos + pagado/saldo)
router.get('/facturas/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).send('Factura no encontrada');

  try {
    const factura = await getFactura(id);
    if (!factura) return res.status(404).send('Factura no encontrada');

    const [proveedores, categorias, cuentas, adjuntos, pagos] = await Promise.all([
      db.query('SELECT id, nombre FROM proveedores ORDER BY nombre'),
      db.query('SELECT id, nombre FROM categorias_gasto ORDER BY nombre'),
      db.query('SELECT id, nombre FROM cuentas ORDER BY nombre'),
      getAdjuntosFactura(id),
      getPagosFactura(id),
    ]);

    res.render('facturas_form', {
      title: 'Editar factura',
      factura,
      proveedores: proveedores.rows,
      categorias: categorias.rows,
      cuentas: cuentas.rows,
      adjuntos,
      pagos,
      lineas: [],
      EDIT: true
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send('Error al cargar la factura');
  }
});

// CREAR/ACTUALIZAR (unificado) + recálculo de estado
router.post('/facturas/guardar', async (req, res) => {
  try {
    const id               = req.body.id ? Number(req.body.id) : null;
    let   proveedor_id     = req.body.proveedor_id ? Number(req.body.proveedor_id) : null;
    const proveedor_nombre = (req.body.proveedor_nombre||'').trim();
    const proveedor_cif    = (req.body.proveedor_cif||'').trim() || null;

    // Alta rápida de proveedor si no se eligió uno
    if (!proveedor_id && proveedor_nombre) {
      const insP = await db.query(
        `INSERT INTO proveedores(nombre, cif, activo) VALUES ($1,$2,true) RETURNING id`,
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

    if (!proveedor_id || !numero || !fecha_emision) {
      return res.status(400).send('Faltan datos obligatorios');
    }

    if (id) {
      await db.query(`
        UPDATE facturas_prov
           SET proveedor_id=$1, categoria_id=$2, cuenta_id=$3, numero=$4,
               fecha_emision=$5, fecha_vencimiento=$6, concepto=$7,
               base_imponible=$8, iva_pct=$9, total=$10, estado=$11, notas=$12
         WHERE id=$14
      `, [proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_venc, concepto,
          base_imponible, iva_pct, total, estado, notas, id]);

      await recalcularEstadoFactura(id);
      return res.redirect(`/contabilidad/facturas/${id}?ok=1`);
    } else {
      const ins = await db.query(`
        INSERT INTO facturas_prov
          (proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_vencimiento,
           concepto, base_imponible, iva_pct, total, estado, notas)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
      `, [proveedor_id, categoria_id, cuenta_id, numero, fecha_emision, fecha_venc, concepto,
          base_imponible, iva_pct, total, estado, notas]);

      await recalcularEstadoFactura(ins.rows[0].id);
      return res.redirect(`/contabilidad/facturas/${ins.rows[0].id}?ok=1`);
    }
  } catch (e) {
    console.error(e);
    return res.redirect('/contabilidad/facturas/nueva');
  }
});

// SUBIR adjuntos
router.post('/facturas/:id/adjuntos', upload.array('adjuntos', 5), async (req, res) => {
  const id = req.params.id;
  try {
    for (const f of req.files || []) {
      await db.query(
        `INSERT INTO factura_adjuntos (factura_id, filename, original_name, mime, size_bytes)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, f.filename, f.originalname, f.mimetype, f.size]
      );
    }
    res.redirect(`/contabilidad/facturas/${id}?ok=1`);
  } catch (e) {
    console.error(e);
    res.redirect(`/contabilidad/facturas/${id}?error=upload`);
  }
});

// ELIMINAR adjunto
router.post('/facturas/:id/adjuntos/:adjuntoId/eliminar', async (req, res) => {
  const { id, adjuntoId } = req.params;
  try {
    const { rows } = await db.query(
      `DELETE FROM factura_adjuntos WHERE id=$1 AND factura_id=$2 RETURNING filename`, [adjuntoId, id]
    );
    if (rows[0]) {
      const filePath = path.join(uploadsDir, rows[0].filename);
      fs.existsSync(filePath) && fs.unlinkSync(filePath);
    }
    res.redirect(`/contabilidad/facturas/${id}?ok=1`);
  } catch (e) {
    console.error(e);
    res.redirect(`/contabilidad/facturas/${id}`);
  }
});

router.post('/facturas/:id/pagos', async (req, res) => {
  const facturaId = Number(req.params.id || 0);
  const importe   = Number(req.body.importe || 0);
  const fecha     = req.body.fecha || null;
  const metodo    = (req.body.metodo || '').trim();
  const referencia= (req.body.referencia || '').trim();
  const notas     = (req.body.notas || '').trim();

  if (!facturaId || !fecha || !(importe > 0)) {
    return res.status(400).send('Faltan datos del pago');
  }

  try {
    // Traer proveedor + saldo actual
    const { rows: facRows } = await db.query(`
      SELECT f.proveedor_id, f.total,
             COALESCE(v.pagado,0) AS pagado
      FROM facturas_prov f
      LEFT JOIN v_factura_sumas_pagos v ON v.factura_id = f.id
      WHERE f.id = $1
    `, [facturaId]);
    if (!facRows.length) return res.status(404).send('Factura no encontrada');

    const proveedor_id = facRows[0].proveedor_id;
    const total   = Number(facRows[0].total || 0);
    const pagado  = Number(facRows[0].pagado || 0);
    const saldo   = Math.max(total - pagado, 0);

    if (importe - saldo > 0.009) {
      return res.status(400).send('El importe supera el saldo de la factura.');
    }

    await db.query('BEGIN');

    // 1) Cabecera del pago
    const { rows: pago } = await db.query(`
      INSERT INTO pagos_prov (proveedor_id, fecha, importe_total, metodo, referencia, notas)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `, [proveedor_id, fecha, +(importe.toFixed(2)), metodo, referencia, notas]);

    // 2) Aplicación a la factura
    await db.query(`
      INSERT INTO pagos_prov_aplicaciones (pago_id, factura_id, importe_aplicado)
      VALUES ($1,$2,$3)
    `, [pago[0].id, facturaId, +(importe.toFixed(2))]);

    await db.query('COMMIT');

    // 3) Recalcular estado de la factura
    await recalcularEstadoFactura(facturaId);

    res.redirect(`/contabilidad/facturas/${facturaId}?ok=1`);
  } catch (e) {
    console.error(e);
    await db.query('ROLLBACK');
    res.status(500).send('No se pudo registrar el pago');
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

router.get('/facturas/export.csv', async (req, res) => {
  // Reutilizamos los mismos filtros que en /facturas (sin paginación)
  const { desde='', hasta='', proveedor='', q='', ordenar='fecha_emision_desc', estado='', venc='' } = req.query;

  const where = [];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (desde)     where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date >= ${push(desde)})`);
  if (hasta)     where.push(`(f.fecha_emision IS NOT NULL AND f.fecha_emision::date <= ${push(hasta)})`);
  if (proveedor) where.push(`f.proveedor_id = ${push(proveedor)}`);
  if (estado)    where.push(`f.estado = ${push(estado)}`);
  if (q) {
    const p = `%${q}%`;
    where.push(`(f.numero ILIKE ${push(p)} OR p.nombre ILIKE ${push(p)} OR f.concepto ILIKE ${push(p)})`);
  }
  if (venc) {
    if (['7','15','30'].includes(venc)) {
      where.push(`(f.fecha_vencimiento IS NOT NULL AND f.fecha_vencimiento::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '${venc} days'))`);
    } else if (venc === 'vencida') {
      where.push(`(f.fecha_vencimiento IS NOT NULL AND f.fecha_vencimiento::date < CURRENT_DATE AND f.estado <> 'pagada')`);
    }
  }

  let orderBy = `f.fecha_emision DESC, f.id DESC`;
  if (ordenar === 'fecha_emision_asc') orderBy = `f.fecha_emision ASC, f.id ASC`;
  if (ordenar === 'proveedor_asc')     orderBy = `p.nombre ASC, f.fecha_emision DESC`;
  if (ordenar === 'proveedor_desc')    orderBy = `p.nombre DESC, f.fecha_emision DESC`;
  if (ordenar === 'total_desc')        orderBy = `f.total DESC NULLS LAST`;
  if (ordenar === 'total_asc')         orderBy = `f.total ASC NULLS FIRST`;

  try {
    const { rows } = await db.query(`
      SELECT f.id, f.numero, f.fecha_emision, f.fecha_vencimiento, p.nombre AS proveedor,
             f.base_imponible AS base, ROUND(f.base_imponible * (f.iva_pct/100.0), 2) AS iva, f.total, f.estado
        FROM facturas_prov f
        LEFT JOIN proveedores p ON p.id = f.proveedor_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${orderBy}
    `, params);

    const header = ['id','numero','fecha_emision','fecha_vencimiento','proveedor','base','iva','total','estado'];
    const data = rows.map(r => [
      r.id, r.numero, (r.fecha_emision||'').toISOString?.().slice(0,10) || String(r.fecha_emision||'').slice(0,10),
      (r.fecha_vencimiento||'').toISOString?.().slice(0,10) || String(r.fecha_vencimiento||'').slice(0,10),
      r.proveedor || '', Number(r.base||0).toFixed(2), Number(r.iva||0).toFixed(2), Number(r.total||0).toFixed(2),
      r.estado || ''
    ]);
    sendCSV(res, `facturas_${new Date().toISOString().slice(0,10)}.csv`, header, data);
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo exportar');
  }
});
router.get('/pagos', async (req, res) => {
  const { desde = '', hasta = '', proveedor = '' } = req.query;

  const where = [];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (desde)     where.push(`p.fecha >= ${push(desde)}`);
  if (hasta)     where.push(`p.fecha <= ${push(hasta)}`);
  if (proveedor) where.push(`p.proveedor_id = ${push(proveedor)}`);

  const sql = `
    SELECT p.id, p.fecha, p.importe_total, p.metodo, p.referencia, p.notas,
           pr.nombre AS proveedor_nombre,
           COALESCE(SUM(a.importe_aplicado),0) AS aplicado
      FROM pagos_prov p
      LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
      LEFT JOIN pagos_prov_aplicaciones a ON a.pago_id = p.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY p.id, pr.nombre
     ORDER BY p.fecha DESC, p.id DESC
     LIMIT 300
  `;
  try {
    const { rows } = await db.query(sql, params);
    const proveedores = await getProveedores();
    res.render('pagos_lista', {
      title: 'Pagos a proveedor',
      hero: false,
      pagos: rows,
      proveedores,
      filtros: { desde, hasta, proveedor }
    });
  } catch (e) {
    console.error(e);
    res.render('pagos_lista', { title:'Pagos a proveedor', hero:false, pagos:[], proveedores:[], filtros:{ desde, hasta, proveedor }});
  }
});

router.get('/pagos/nuevo', async (req, res) => {
  try {
    const proveedores = await getProveedores();
    const proveedorSel = req.query.proveedor ? Number(req.query.proveedor) : null;
    const facturasPend = proveedorSel ? await getFacturasPendientesProveedor(proveedorSel) : [];
    res.render('pagos_form', {
      title: 'Registrar pago',
      hero: false,
      proveedores,
      proveedorSel,
      facturasPend,
      hoy: new Date().toISOString().slice(0,10)
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error al cargar el formulario de pago');
  }
});

router.post('/pagos/guardar', async (req, res) => {
  const proveedor_id  = Number(req.body.proveedor_id || 0);
  const fecha         = req.body.fecha;
  const importe_total = Number(req.body.importe_total || 0);
  const metodo        = (req.body.metodo || '').trim();
  const referencia    = (req.body.referencia || '').trim();
  const notas         = (req.body.notas || '').trim();

  // aplicaciones vendrán como aplicaciones[<facturaId>] = importe
  const aplicaciones  = Object.entries(req.body.aplicaciones || {})
    .map(([facturaId, imp]) => ({ factura_id: Number(facturaId), importe: Number(imp || 0) }))
    .filter(x => x.factura_id && x.importe > 0);

  const sumaAplicada = aplicaciones.reduce((acc, x) => acc + x.importe, 0);

  if (!proveedor_id || !fecha || importe_total <= 0) {
    return res.status(400).send('Faltan datos del pago');
  }
  if (sumaAplicada - importe_total > 0.009) {
    return res.status(400).send('La suma aplicada excede el importe del pago');
  }

  const afectadas = [...new Set(aplicaciones.map(x => x.factura_id))];

  try {
    await db.query('BEGIN');

    const { rows: pago } = await db.query(
      `INSERT INTO pagos_prov (proveedor_id, fecha, importe_total, metodo, referencia, notas)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [proveedor_id, fecha, +(importe_total.toFixed(2)), metodo, referencia, notas]
    );

    for (const a of aplicaciones) {
      await db.query(
        `INSERT INTO pagos_prov_aplicaciones (pago_id, factura_id, importe_aplicado)
         VALUES ($1,$2,$3)`,
        [pago[0].id, a.factura_id, +(a.importe.toFixed(2))]
      );
    }

    await db.query('COMMIT');

    // Recalcular estados (fuera de la transacción)
    await Promise.all(afectadas.map(id => recalcularEstadoFactura(id)));

    res.redirect('/contabilidad/pagos?ok=1');
  } catch (e) {
    console.error(e);
    await db.query('ROLLBACK');
    res.status(500).send('No se pudo guardar el pago');
  }
});

router.post('/pagos/:id/eliminar', async (req, res) => {
  const pagoId = Number(req.params.id);
  if (!pagoId) return res.redirect('/contabilidad/pagos');

  try {
    // facturas afectadas antes de borrar
    const { rows: af } = await db.query(
      `SELECT DISTINCT factura_id FROM pagos_prov_aplicaciones WHERE pago_id=$1`, [pagoId]
    );
    await db.query('BEGIN');
    await db.query(`DELETE FROM pagos_prov WHERE id=$1`, [pagoId]); // CASCADE sobre aplicaciones
    await db.query('COMMIT');

    await Promise.all(af.map(r => recalcularEstadoFactura(r.factura_id)));
    res.redirect('/contabilidad/pagos?ok=1');
  } catch (e) {
    console.error(e);
    await db.query('ROLLBACK');
    res.redirect('/contabilidad/pagos?error=1');
  }
});

router.get('/pagos/export.csv', async (req, res) => {
  const { desde='', hasta='', proveedor='' } = req.query;

  const where = [];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (desde)     where.push(`p.fecha >= ${push(desde)}`);
  if (hasta)     where.push(`p.fecha <= ${push(hasta)}`);
  if (proveedor) where.push(`p.proveedor_id = ${push(proveedor)}`);

  try {
    const { rows } = await db.query(`
      SELECT p.id, p.fecha, pr.nombre AS proveedor, p.importe_total,
             COALESCE(SUM(a.importe_aplicado),0) AS aplicado,
             p.metodo, p.referencia, p.notas
        FROM pagos_prov p
        LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
        LEFT JOIN pagos_prov_aplicaciones a ON a.pago_id = p.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY p.id, pr.nombre
       ORDER BY p.fecha DESC, p.id DESC
    `, params);

    const header = ['id','fecha','proveedor','importe_total','aplicado','metodo','referencia','notas'];
    const data = rows.map(r => [
      r.id, (r.fecha||'').toISOString?.().slice(0,10) || String(r.fecha||'').slice(0,10),
      r.proveedor||'', Number(r.importe_total||0).toFixed(2), Number(r.aplicado||0).toFixed(2),
      r.metodo||'', r.referencia||'', r.notas||''
    ]);
    sendCSV(res, `pagos_${new Date().toISOString().slice(0,10)}.csv`, header, data);
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo exportar pagos');
  }
});
// DETALLE de un pago (solo columnas que existen en tu esquema actual)
router.get('/pagos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).send('Pago no encontrado');

  try {
    // Pago + proveedor + total aplicado (subquery -> sin GROUP BY problemáticos)
    const pagoQ = await db.query(`
      SELECT
        p.id, p.proveedor_id, p.cuenta_id, p.fecha,
        p.importe_total AS importe_total,
        p.metodo, p.referencia, p.notas, p.created_at,
        pr.nombre AS proveedor_nombre,
        (
          SELECT COALESCE(SUM(a.importe_aplicado), 0)
          FROM pagos_prov_aplicaciones a
          WHERE a.pago_id = p.id
        ) AS aplicado
      FROM pagos_prov p
      LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
      WHERE p.id = $1
      LIMIT 1
    `, [id]);

    if (!pagoQ.rows.length) return res.status(404).send('Pago no encontrado');
    const pago = pagoQ.rows[0];

    // Aplicaciones (usa solo importe_aplicado)
    const appsQ = await db.query(`
      SELECT
        a.id,
        a.pago_id,
        a.factura_id,
        a.importe_aplicado,
        f.numero,
        f.fecha_emision,
        f.total
      FROM pagos_prov_aplicaciones a
      LEFT JOIN facturas_prov f ON f.id = a.factura_id
      WHERE a.pago_id = $1
      ORDER BY a.id ASC
    `, [id]);

    res.render('pagos_detalle', {
      title: `Pago #${id}`,
      pago,
      aplicaciones: appsQ.rows || []
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error cargando el pago');
  }
});

module.exports = router;
