const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');
const path = require('path');
const { generarReciboPago } = require('../utils/pdfRecibos');

// POST: Registrar un nuevo pago
router.post('/', async (req, res) => {
  const { alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones } = req.body;

  try {
    // 1. Verificar cuotas impagadas
    const cuotasImpagasRes = await db.query(`
      SELECT ca.id, c.precio AS importe_cuota
      FROM cuotas_alumno ca
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE ca.alumno_id = $1 AND ca.pagado = false
      ORDER BY ca.fecha_vencimiento ASC
    `, [alumno_id]);

    const cuotasImpagas = cuotasImpagasRes.rows;

    if (cuotasImpagas.length === 0) {
      // No hay cuotas impagadas → mostrar error en el formulario
      const alumnoRes = await db.query(`SELECT * FROM alumnos WHERE id = $1`, [alumno_id]);
      const alumno = alumnoRes.rows[0];

      const [cuotasDisponiblesRes, cuotasAlumnoRes, pagosRes] = await Promise.all([
        db.query(`SELECT * FROM cuotas ORDER BY nombre`),
        db.query(`
          SELECT ca.*, c.nombre AS nombre_cuota, c.precio
          FROM cuotas_alumno ca
          JOIN cuotas c ON ca.cuota_id = c.id
          WHERE ca.alumno_id = $1
          ORDER BY ca.fecha_vencimiento ASC
        `, [alumno_id]),
        db.query(`
          SELECT p.id AS pago_id, p.fecha_pago, p.importe AS importe_pago, p.medio_pago, p.referencia,
                 p.observaciones, c.nombre AS cuota_nombre, pca.importe_aplicado
          FROM pagos p
          JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
          JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
          JOIN cuotas c ON ca.cuota_id = c.id
          WHERE p.alumno_id = $1
          ORDER BY p.fecha_pago DESC
        `, [alumno_id])
      ]);

      // Generar nueva referencia sugerida
      const today = new Date();
      const base = `P${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
      let sufijo = 0;
      let nuevaRef = base;

      while (true) {
        const refCheck = await db.query(`SELECT 1 FROM pagos WHERE referencia = $1`, [nuevaRef]);
        if (refCheck.rows.length === 0) break;
        sufijo++;
        nuevaRef = `${base}-${sufijo}`;
      }

      return res.render('pago_form', {
        alumno,
        pagos: pagosRes.rows,
        cuotasDisponibles: cuotasDisponiblesRes.rows,
        cuotasAlumno: cuotasAlumnoRes.rows,
        referenciaSugerida: nuevaRef,
        modoEdicion: false,
        errorMsg: 'No hay cuotas impagadas a las que aplicar el pago.'
      });
    }

    // 2. Generar referencia si no se proporcionó
    let ref = referencia?.trim();
    if (!ref) {
      const base = `P${String(new Date(fecha_pago).getMonth() + 1).padStart(2, '0')}${String(new Date(fecha_pago).getDate()).padStart(2, '0')}`;
      let sufijo = 0;
      let nuevaRef = base;

      while (true) {
        const existe = await db.query(`SELECT 1 FROM pagos WHERE referencia = $1`, [nuevaRef]);
        if (existe.rows.length === 0) break;
        sufijo++;
        nuevaRef = `${base}-${sufijo}`;
      }

      ref = nuevaRef;
    }

    // 3. Insertar el pago
    const result = await db.query(`
      INSERT INTO pagos (alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [alumno_id, importe, fecha_pago, medio_pago, ref, observaciones]);

    const pagoId = result.rows[0].id;
    let restante = parseFloat(importe);

    // 4. Aplicar a cuotas impagadas
    for (const cuota of cuotasImpagas) {
      if (restante <= 0) break;

      const aplicar = Math.min(restante, cuota.importe_cuota);
      restante -= aplicar;

      await db.query(`
        INSERT INTO pago_cuota_alumno (pago_id, cuota_alumno_id, importe_aplicado)
        VALUES ($1, $2, $3)
      `, [pagoId, cuota.id, aplicar]);

      const totalResult = await db.query(`
        SELECT SUM(importe_aplicado) AS total_pagado
        FROM pago_cuota_alumno
        WHERE cuota_alumno_id = $1
      `, [cuota.id]);

      const totalPagado = parseFloat(totalResult.rows[0].total_pagado || 0);
      if (totalPagado >= cuota.importe_cuota) {
        await db.query(`UPDATE cuotas_alumno SET pagado = true WHERE id = $1`, [cuota.id]);
      }
    }

    // 5. Redirigir a ficha del alumno
    res.redirect(`/alumnos/${alumno_id}?tab=finanzas`);
  } catch (err) {
    console.error('❌ Error al registrar pago:', err.message);
    res.status(500).send('Error al registrar el pago');
  }
});
router.post('/generar-cuotas', async (req, res) => {
  const { alumno_id, cuota_id, fecha_inicio, fecha_fin } = req.body;

  try {
    const fechaIni = new Date(fecha_inicio);
    const fechaFin = new Date(fecha_fin);

    const tipoRes = await db.query(`
      SELECT tc.tipo FROM cuotas c
      JOIN tipos_cuota tc ON c.tipo_id = tc.id
      WHERE c.id = $1
    `, [cuota_id]);

    if (tipoRes.rows.length === 0) throw new Error('Tipo de cuota no encontrado');
    const tipo = tipoRes.rows[0].tipo;

    let fechaActual = new Date(fechaIni);

    while (fechaActual <= fechaFin) {
      const año = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
      const dia = String(fechaActual.getDate()).padStart(2, '0');
      const fechaVenc = `${año}-${mes}-${dia}`;

      const { rows } = await db.query(
        `SELECT 1 FROM cuotas_alumno WHERE alumno_id = $1 AND cuota_id = $2 AND fecha_vencimiento = $3`,
        [alumno_id, cuota_id, fechaVenc]
      );

      if (rows.length === 0) {
        await db.query(
          `INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
           VALUES ($1, $2, $3, false)`,
          [alumno_id, cuota_id, fechaVenc]
        );
      }

      if (tipo === 'Mensual') {
        fechaActual.setMonth(fechaActual.getMonth() + 1);
      } else if (tipo === 'Semanal') {
        fechaActual.setDate(fechaActual.getDate() + 7);
      } else if (tipo === 'Puntual') {
        break;
      }
    }

    res.redirect('/alumnos/' + alumno_id + '?tab=finanzas');
  } catch (err) {
    console.error('Error al generar cuotas:', err);
    res.status(500).send('Error al generar cuotas');
  }
});
router.get('/nuevo/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;

  try {
    const alumnoRes = await db.query(`SELECT * FROM alumnos WHERE id = $1`, [alumnoId]);
    const alumno = alumnoRes.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const grupos = alumno.grupos || '';

    // Generar referencia sugerida: P + MMDD + sufijo si ya existe
    const today = new Date();
    const base = `P${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    let sufijo = 0;
    let nuevaRef = base;

    while (true) {
      const refCheck = await db.query(`SELECT 1 FROM pagos WHERE referencia = $1`, [nuevaRef]);
      if (refCheck.rows.length === 0) break;
      sufijo++;
      nuevaRef = `${base}-${sufijo}`;
    }

    const pagosRes = await db.query(
      `SELECT * FROM pagos WHERE alumno_id = $1 ORDER BY fecha_pago DESC`,
      [alumnoId]
    );

    const cuotasDisponiblesRes = await db.query(
      `SELECT * FROM cuotas ORDER BY nombre`
    );

    const cuotasAlumnoRes = await db.query(`
      SELECT 
        ca.*, 
        c.nombre AS nombre_cuota, 
        c.precio
      FROM cuotas_alumno ca
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE ca.alumno_id = $1
      ORDER BY ca.fecha_vencimiento ASC
    `, [alumnoId]);

    // Filtrar cuotas impagadas
    const cuotasImpagadas = cuotasAlumnoRes.rows.filter(c => !c.pagado);

    // Si no hay cuotas impagadas, no se permite registrar pago
    if (cuotasImpagadas.length === 0) {
      return res.render('pago_form', {
        alumno: { ...alumno, grupos },
        pagos: pagosRes.rows,
        cuotasDisponibles: cuotasDisponiblesRes.rows,
        cuotasAlumno: [],
        referenciaSugerida: nuevaRef,
        modoEdicion: false,
        errorMsg: 'No puedes registrar un pago porque no hay cuotas impagadas.'
      });
    }

    // Renderizar formulario normal
    res.render('pago_form', {
      alumno: { ...alumno, grupos },
      pagos: pagosRes.rows,
      cuotasDisponibles: cuotasDisponiblesRes.rows,
      cuotasAlumno: cuotasImpagadas,
      referenciaSugerida: nuevaRef,
      modoEdicion: false,
      errorMsg: null
    });

  } catch (err) {
    console.error('❌ Error cargando formulario de pagos:', err.message);
    res.status(500).send('Error cargando datos');
  }
});
// GET: Detalles de pagos de un alumno
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
// GET: Generar recibo PDF
router.get('/:id/recibo', async (req, res) => {
  const pagoId = parseInt(req.params.id, 10);

  try {
    // Datos generales del pago y del alumno
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

    // Cuotas aplicadas a este pago
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

    // Generar PDF
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
// GET /pagos/api/:alumnoId?page=1
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
router.get('/:pagoId/editar', async (req, res) => {
  const { pagoId } = req.params;

  try {
    const pagoRes = await db.query(`
      SELECT * FROM pagos WHERE id = $1
    `, [pagoId]);

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
router.post('/:pagoId/actualizar', async (req, res) => {
  const { pagoId } = req.params;
  const { importe, fecha_pago, medio_pago, referencia, observaciones } = req.body;

  try {
    await db.query(`
      UPDATE pagos SET importe = $1, fecha_pago = $2, medio_pago = $3, referencia = $4, observaciones = $5
      WHERE id = $6
    `, [importe, fecha_pago, medio_pago, referencia, observaciones, pagoId]);

    const alumnoId = req.body.alumno_id;
    res.redirect(`/alumnos/${alumnoId}?tab=finanzas`);
  } catch (err) {
    console.error('❌ Error al actualizar pago:', err.message);
    res.status(500).send('Error al actualizar el pago');
  }
});
router.post('/:pagoId/eliminar', async (req, res) => {
  const { pagoId } = req.params;

  try {
    // 1. Obtener cuotas afectadas antes de eliminar relaciones
    const cuotasRes = await db.query(`
      SELECT pca.cuota_alumno_id, c.precio
      FROM pago_cuota_alumno pca
      JOIN cuotas_alumno ca ON ca.id = pca.cuota_alumno_id
      JOIN cuotas c ON c.id = ca.cuota_id
      WHERE pca.pago_id = $1
    `, [pagoId]);
    const cuotasAfectadas = cuotasRes.rows;

    // 2. Eliminar las relaciones del pago con las cuotas
    await db.query(`DELETE FROM pago_cuota_alumno WHERE pago_id = $1`, [pagoId]);

    // 3. Eliminar el pago y obtener el alumno_id
    const pagoRes = await db.query(`DELETE FROM pagos WHERE id = $1 RETURNING alumno_id`, [pagoId]);
    if (!pagoRes.rows.length) {
      return res.status(404).send('Pago no encontrado');
    }
    const alumnoId = pagoRes.rows[0].alumno_id;

    // 4. Recalcular estado de las cuotas afectadas
    for (const { cuota_alumno_id, precio } of cuotasAfectadas) {
      const sumRes = await db.query(`
        SELECT SUM(importe_aplicado) AS total_pagado
        FROM pago_cuota_alumno
        WHERE cuota_alumno_id = $1
      `, [cuota_alumno_id]);

      const totalPagado = parseFloat(sumRes.rows[0].total_pagado || 0);
      const pagado = Math.round(totalPagado * 100) >= Math.round(parseFloat(precio) * 100);

      await db.query(
        `UPDATE cuotas_alumno SET pagado = $1 WHERE id = $2`,
        [pagado, cuota_alumno_id]
      );
    }

    console.log(`✅ Pago ${pagoId} eliminado. Recalculadas ${cuotasAfectadas.length} cuotas.`);
    res.redirect(`/alumnos/${alumnoId}?tab=finanzas`);
  } catch (err) {
    console.error('❌ Error al eliminar pago:', err.message);
    res.status(500).send('Error al eliminar el pago');
  }
});


module.exports = router;