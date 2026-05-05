// routes/pagos.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');
const { generarReciboPago } = require('../utils/pdfRecibos');
const { toISODate } = require('../utils/fechas');

// --- helpers (ponlos arriba del archivo si aún no existen)
function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}
function toISOorNull(v) {
  if (!v) return null;
  const s = String(v);
  if (s.includes('T')) return s.split('T')[0];
  // acepta "YYYY-MM-DD" o similares que Date entienda
  const d = new Date(s);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}
async function ensureUniqueRef(base, clientOrDb) {
  // Pbase, Pbase-1, Pbase-2...
  let sufijo = 0;
  let ref = base;
  // usa el cliente pasado (transacción) o el pool
  const runner = clientOrDb.query ? clientOrDb : db;
  // evita bucles infinitos; muy improbable
  for (let i = 0; i < 1000; i++) {
    const { rows } = await runner.query(`SELECT 1 FROM pagos WHERE referencia = $1`, [ref]);
    if (rows.length === 0) return ref;
    sufijo++;
    ref = `${base}-${sufijo}`;
  }
  throw new Error('No se pudo generar referencia única');
}

// POST: Registrar un nuevo pago (con validación y saldo a favor)
router.post('/', async (req, res) => {
  const { alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones } = req.body;

  // Validaciones básicas
  const importeNum = round2(importe);
  if (!Number.isFinite(importeNum) || importeNum <= 0) {
    return res.status(400).send('El importe debe ser un número positivo.');
  }

  const fechaPagoISO = toISOorNull(fecha_pago) || new Date().toISOString().slice(0,10);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Asegurar tabla de saldo (idempotente)
    await client.query(`
      CREATE TABLE IF NOT EXISTS saldo_alumno (
        alumno_id INTEGER PRIMARY KEY REFERENCES alumnos(id) ON DELETE CASCADE,
        saldo NUMERIC(10,2) NOT NULL DEFAULT 0
      )
    `);

    // 1) Obtener cuotas impagadas (bloqueadas)
    const cuotasImpagasRes = await client.query(`
      SELECT ca.id, c.precio AS importe_cuota
      FROM cuotas_alumno ca
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE ca.alumno_id = $1 AND ca.pagado = false
      ORDER BY ca.fecha_vencimiento ASC, ca.id ASC
      FOR UPDATE
    `, [alumno_id]);

    const cuotasImpagas = cuotasImpagasRes.rows;

    // 2) Generar/validar referencia
    let refFinal = (referencia || '').trim();
    if (!refFinal) {
      const d = new Date(`${fechaPagoISO}T00:00:00`);
      const base = `P${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      refFinal = await ensureUniqueRef(base, client);
    } else {
      const ex = await client.query(`SELECT 1 FROM pagos WHERE referencia = $1`, [refFinal]);
      if (ex.rows.length) {
        refFinal = await ensureUniqueRef(refFinal, client);
      }
    }

    // 3) Insertar pago
    const pagoRes = await client.query(`
      INSERT INTO pagos (alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      alumno_id,
      importeNum,
      fechaPagoISO,
      medio_pago,
      refFinal,
      observaciones?.trim() || null
    ]);
    const pagoId = pagoRes.rows[0].id;

    // 4) Aplicar a cuotas; si sobra → saldo
    let restante = importeNum;

    for (const cuota of cuotasImpagas) {
      if (restante <= 0) break;

      const sumRes = await client.query(`
        SELECT COALESCE(SUM(importe_aplicado),0) AS total_pagado
        FROM pago_cuota_alumno
        WHERE cuota_alumno_id = $1
        FOR UPDATE
      `, [cuota.id]);

      const totalPagado = round2(sumRes.rows[0].total_pagado || 0);
      const pendiente = Math.max(0, round2(cuota.importe_cuota - totalPagado));
      if (pendiente <= 0) {
        await client.query(`UPDATE cuotas_alumno SET pagado = true WHERE id = $1`, [cuota.id]);
        continue;
      }

      const aplicar = round2(Math.min(restante, pendiente));
      if (aplicar > 0) {
        await client.query(`
          INSERT INTO pago_cuota_alumno (pago_id, cuota_alumno_id, importe_aplicado)
          VALUES ($1, $2, $3)
        `, [pagoId, cuota.id, aplicar]);

        const sum2 = await client.query(`
          SELECT COALESCE(SUM(importe_aplicado),0) AS total_pagado
          FROM pago_cuota_alumno
          WHERE cuota_alumno_id = $1
        `, [cuota.id]);

        const pagadoAhora = round2(sum2.rows[0].total_pagado || 0);
        if (pagadoAhora >= round2(cuota.importe_cuota)) {
          await client.query(`UPDATE cuotas_alumno SET pagado = true WHERE id = $1`, [cuota.id]);
        }

        restante = round2(restante - aplicar);
      }
    }

    // 5) Si queda superávit, acumular en saldo_alumno
    if (restante > 0) {
      await client.query(`
        INSERT INTO saldo_alumno (alumno_id, saldo)
        VALUES ($1, $2)
        ON CONFLICT (alumno_id)
        DO UPDATE SET saldo = ROUND(saldo_alumno.saldo + EXCLUDED.saldo, 2)
      `, [alumno_id, restante]);
    }

    await client.query('COMMIT');
    res.redirect(`/alumnos/${alumno_id}?tab=finanzas`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error al registrar pago:', err);
    res.status(500).send('Error al registrar el pago');
  } finally {
    client.release();
  }
});


// Generar cuotas (por rango y tipo)
// ─────────────────────────────────────────────────────────────────
// REEMPLAZA únicamente esta función en routes/pagos.js
// Busca: router.post('/generar-cuotas', ...
// ─────────────────────────────────────────────────────────────────

// ✅ CORREGIDO: de N queries en bucle → 1 INSERT masivo con unnest
// ✅ CORREGIDO: usa cliente dedicado + transacción
// ✅ CORREGIDO: ON CONFLICT DO NOTHING evita duplicados sin SELECT previo
//    (requiere: UNIQUE(alumno_id, cuota_id, fecha_vencimiento) — ya la creamos en cuotas.js)
router.post('/generar-cuotas', async (req, res) => {
  const { alumno_id, cuota_id, fecha_inicio, fecha_fin } = req.body;
  const inicioISO = toISOorNull(fecha_inicio);
  const finISO    = toISOorNull(fecha_fin);

  if (!alumno_id || !cuota_id || !inicioISO || !finISO) {
    return res.status(400).send('Datos inválidos para generar cuotas');
  }

  const client = await db.connect();
  try {
    // 1) Tipo de cuota para saber la periodicidad
    const { rows: tipoRows } = await client.query(
      `SELECT tc.tipo FROM cuotas c
       JOIN tipos_cuota tc ON c.tipo_id = tc.id
       WHERE c.id = $1`,
      [cuota_id]
    );
    if (!tipoRows.length) return res.status(400).send('Tipo de cuota no encontrado');
    const tipo = tipoRows[0].tipo;

    // 2) Generar todas las fechas de vencimiento en memoria
    const fechas = [];
    let fechaActual = new Date(`${inicioISO}T00:00:00`);
    const fin       = new Date(`${finISO}T23:59:59`);

    while (fechaActual <= fin) {
      const año = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
      const dia = String(fechaActual.getDate()).padStart(2, '0');
      fechas.push(`${año}-${mes}-${dia}`);

      if (tipo === 'Mensual') {
        fechaActual.setMonth(fechaActual.getMonth() + 1);
      } else if (tipo === 'Semanal') {
        fechaActual.setDate(fechaActual.getDate() + 7);
      } else {
        // Puntual u otro tipo desconocido: solo una fecha
        break;
      }
    }

    if (!fechas.length) {
      return res.status(400).send('El rango de fechas no genera ningún vencimiento.');
    }

    // 3) Un solo INSERT masivo — ON CONFLICT DO NOTHING evita duplicados
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
       SELECT $1, $2, t.fecha, false
       FROM unnest($3::date[]) AS t(fecha)
       ON CONFLICT (alumno_id, cuota_id, fecha_vencimiento) DO NOTHING`,
      [alumno_id, cuota_id, fechas]
    );
    await client.query('COMMIT');

    console.log(`[pagos/generar-cuotas] alumno=${alumno_id} cuota=${cuota_id} fechas=${fechas.length}`);
    res.redirect(`/alumnos/${alumno_id}?tab=finanzas`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[pagos/generar-cuotas] Error:', err);
    res.status(500).send('Error al generar cuotas');
  } finally {
    client.release();
  }
});

router.get('/nuevo/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;

  try {
    const alumnoRes = await db.query(`SELECT * FROM alumnos WHERE id = $1`, [alumnoId]);
    const alumno = alumnoRes.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const todayISO = new Date().toISOString().slice(0,10);
    const d = new Date(`${todayISO}T00:00:00`);
    const base = `P${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    // Usa ensureUniqueRef con una conexión normal (no hace falta transacción aquí)
    const refSugerida = await ensureUniqueRef(base, db);

    const [pagosRes, cuotasDisponiblesRes, cuotasAlumnoRes] = await Promise.all([
      db.query(`SELECT * FROM pagos WHERE alumno_id = $1 ORDER BY fecha_pago DESC`, [alumnoId]),
      db.query(`SELECT * FROM cuotas ORDER BY nombre`),
      db.query(`
        SELECT ca.*, c.nombre AS nombre_cuota, c.precio
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
        ORDER BY ca.fecha_vencimiento ASC
      `, [alumnoId])
    ]);

    const cuotasImpagadas = cuotasAlumnoRes.rows.filter(c => !c.pagado);

    if (cuotasImpagadas.length === 0) {
      return res.render('pago_form', {
        alumno,
        pagos: pagosRes.rows,
        cuotasDisponibles: cuotasDisponiblesRes.rows,
        cuotasAlumno: [],
        referenciaSugerida: refSugerida,
        modoEdicion: false,
        errorMsg: 'No puedes registrar un pago porque no hay cuotas impagadas.'
      });
    }

    res.render('pago_form', {
      alumno,
      pagos: pagosRes.rows,
      cuotasDisponibles: cuotasDisponiblesRes.rows,
      cuotasAlumno: cuotasImpagadas,
      referenciaSugerida: refSugerida,
      modoEdicion: false,
      errorMsg: null
    });

  } catch (err) {
    console.error('❌ Error cargando formulario de pagos:', err.message);
    res.status(500).send('Error cargando datos');
  }
});

// Detalle de pagos de un alumno (sin cambios funcionales relevantes)
router.get('/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const alumnoResult = await db.query('SELECT * FROM alumnos WHERE id = $1', [id]);
    if (alumnoResult.rows.length === 0) return res.status(404).send('Alumno no encontrado');
    const alumno = alumnoResult.rows[0];

    const pagosResult = await db.query(`
      SELECT 
        p.id AS pago_id,
        p.fecha_pago,
        p.importe AS importe_pago,
        p.medio_pago,
        p.referencia,
        p.observaciones,
        c.nombre AS cuota_nombre,
        pca.importe_aplicado,
        (
          SELECT SUM(pca2.importe_aplicado)
          FROM pago_cuota_alumno pca2
          WHERE pca2.pago_id = p.id
        ) AS total_aplicado
      FROM pagos p
      JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
      JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE p.alumno_id = $1
      ORDER BY p.fecha_pago DESC
    `, [id]);

    const instrumentos = await db.query(`
      SELECT i.nombre FROM instrumentos i
      JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
      WHERE ai.alumno_id = $1
    `, [id]);

    const grupos = await db.query(`
      SELECT g.nombre FROM grupos g
      JOIN alumno_grupo ag ON g.id = ag.grupo_id
      WHERE ag.alumno_id = $1
    `, [id]);

    const cuotas = await db.query('SELECT * FROM cuotas ORDER BY nombre');

    res.render('alumnos_ficha', {
      alumno: {
        ...alumno,
        instrumentos: instrumentos.rows.map(i => i.nombre).join(', '),
        grupos: grupos.rows.map(g => g.nombre).join(', ')
      },
      pagos: pagosResult.rows,
      cuotasDisponibles: cuotas.rows
    });

  } catch (err) {
    console.error('❌ Error al cargar ficha de alumno:', err.message);
    res.status(500).send('Error al obtener datos del alumno');
  }
});

// Generar recibo PDF (lo dejamos igual; tú cambiarás el PDF luego)
router.get('/:id/recibo', async (req, res) => {
  const pagoId = parseInt(req.params.id, 10);

  try {
    const pagoResult = await db.query(`
      SELECT p.*, a.nombre AS nombre_alumno, a.apellidos, a.dni, a.email
      FROM pagos p
      JOIN alumnos a ON p.alumno_id = a.id
      WHERE p.id = $1
    `, [pagoId]);

    if (pagoResult.rows.length === 0) {
      return res.status(404).send('Pago no encontrado');
    }
    const pago = pagoResult.rows[0];

    const cuotasResult = await db.query(`
      SELECT 
        c.nombre AS cuota_nombre,
        ca.fecha_vencimiento,
        pca.importe_aplicado
      FROM pago_cuota_alumno pca
      JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE pca.pago_id = $1
    `, [pagoId]);

    const cuotas = cuotasResult.rows;

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-disposition', `attachment; filename="recibo_${pago.referencia || 'sin_ref'}.pdf"`);

    generarReciboPago(doc, pago, cuotas);
    doc.pipe(res);
    doc.end();

  } catch (err) {
    console.error('❌ Error al generar recibo:', err.message);
    res.status(500).send('Error al generar el recibo');
  }
});

// AJAX paginación (sin cambios)
router.get('/ajax/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;
  const offset = parseInt(req.query.offset || 0);
  const limit = 5;

  try {
    const pagosRes = await db.query(`
      SELECT 
        p.id AS pago_id,
        p.fecha_pago,
        p.importe AS importe_pago,
        p.medio_pago,
        p.referencia,
        p.observaciones,
        c.nombre AS cuota_nombre,
        pca.importe_aplicado
      FROM pagos p
      JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
      JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE p.alumno_id = $1
      ORDER BY p.fecha_pago DESC
      LIMIT $2 OFFSET $3
    `, [alumnoId, limit, offset]);

    res.json(pagosRes.rows);
  } catch (err) {
    console.error('❌ Error cargando más pagos:', err);
    res.status(500).json({ error: 'Error al cargar pagos' });
  }
});

// API paginada (sin cambios)
router.get('/api/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;
  const page = parseInt(req.query.page) || 1;
  const perPage = 5;
  const offset = (page - 1) * perPage;

  try {
    const result = await db.query(`
      SELECT 
        p.id AS pago_id,
        p.fecha_pago,
        p.importe AS importe_pago,
        p.medio_pago,
        p.referencia,
        p.observaciones,
        c.nombre AS cuota_nombre,
        pca.importe_aplicado
      FROM pagos p
      JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
      JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE p.alumno_id = $1
      ORDER BY p.fecha_pago DESC
      LIMIT $2 OFFSET $3
    `, [alumnoId, perPage, offset]);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error paginando pagos:', err.message);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

// Editar pago
router.get('/:pagoId/editar', async (req, res) => {
  const { pagoId } = req.params;

  try {
    const pagoRes = await db.query(`SELECT * FROM pagos WHERE id = $1`, [pagoId]);
    const pago = pagoRes.rows[0];
    if (!pago) return res.status(404).send('Pago no encontrado');

    const alumnoRes = await db.query(`SELECT * FROM alumnos WHERE id = $1`, [pago.alumno_id]);
    const alumno = alumnoRes.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    res.render('pago_form', {
      alumno,
      pago,
      modoEdicion: true,
      errorMsg: null
    });
  } catch (err) {
    console.error('❌ Error cargando edición de pago:', err.message);
    res.status(500).send('Error cargando datos del pago');
  }
});

// Actualizar pago (solo sus campos; no re-reparte automáticamente)
router.post('/:pagoId/actualizar', async (req, res) => {
  const { pagoId } = req.params;
  const { importe, fecha_pago, medio_pago, referencia, observaciones, alumno_id } = req.body;

  const fechaISO = toISOorNull(fecha_pago) || new Date().toISOString().slice(0,10);
  const importeNum = round2(importe);

  try {
    await db.query(`
      UPDATE pagos
         SET importe = $1, fecha_pago = $2, medio_pago = $3, referencia = $4, observaciones = $5
       WHERE id = $6
    `, [importeNum, fechaISO, medio_pago, (referencia || '').trim(), observaciones?.trim() || null, pagoId]);

    // Nota: si quisieras re-prorratear tras cambiar el importe, habría que desfazer y rehacer
    // los pca, pero por ahora mantenemos tu comportamiento original.
    res.redirect(`/alumnos/${alumno_id}?tab=finanzas`);
  } catch (err) {
    console.error('❌ Error al actualizar pago:', err.message);
    res.status(500).send('Error al actualizar el pago');
  }
});

// Eliminar pago (recalcula estado de cuotas afectadas)
router.post('/:pagoId/eliminar', async (req, res) => {
  const { pagoId } = req.params;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cuotasRes = await client.query(`
      SELECT pca.cuota_alumno_id, c.precio
      FROM pago_cuota_alumno pca
      JOIN cuotas_alumno ca ON ca.id = pca.cuota_alumno_id
      JOIN cuotas c ON c.id = ca.cuota_id
      WHERE pca.pago_id = $1
      FOR UPDATE
    `, [pagoId]);

    await client.query(`DELETE FROM pago_cuota_alumno WHERE pago_id = $1`, [pagoId]);

    const pagoRes = await client.query(`DELETE FROM pagos WHERE id = $1 RETURNING alumno_id`, [pagoId]);
    if (!pagoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Pago no encontrado');
    }
    const alumnoId = pagoRes.rows[0].alumno_id;

    // Recalcular estado
    for (const { cuota_alumno_id, precio } of cuotasRes.rows) {
      const sumRes = await client.query(`
        SELECT COALESCE(SUM(importe_aplicado),0) AS total_pagado
        FROM pago_cuota_alumno
        WHERE cuota_alumno_id = $1
      `, [cuota_alumno_id]);

      const totalPagado = round2(sumRes.rows[0].total_pagado || 0);
      const pagado = totalPagado >= round2(precio);

      await client.query(
        `UPDATE cuotas_alumno SET pagado = $1 WHERE id = $2`,
        [pagado, cuota_alumno_id]
      );
    }

    await client.query('COMMIT');
    res.redirect(`/alumnos/${alumnoId}?tab=finanzas`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error al eliminar pago:', err.message);
    res.status(500).send('Error al eliminar el pago');
  } finally {
    client.release();
  }
});

module.exports = router;
