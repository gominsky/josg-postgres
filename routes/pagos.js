const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');

// POST: Registrar un nuevo pago
router.post('/', async (req, res) => {
  const { alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones } = req.body;

  try {
    // Insertar el pago
    const result = await db.query(`
      INSERT INTO pagos (alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones]);

    const pagoId = result.rows[0].id;
    let restante = parseFloat(importe);

    // Buscar cuotas no pagadas del alumno
    const cuotasResult = await db.query(`
      SELECT ca.id, c.precio AS importe_cuota
      FROM cuotas_alumno ca
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE ca.alumno_id = $1 AND ca.pagado = false
      ORDER BY ca.fecha_vencimiento ASC
    `, [alumno_id]);

    const cuotas = cuotasResult.rows;

    for (const cuota of cuotas) {
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
        await db.query(`
          UPDATE cuotas_alumno SET pagado = true WHERE id = $1
        `, [cuota.id]);
      }
    }

    res.redirect('/alumnos/' + alumno_id);
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

    let fechaActual = new Date(fechaIni.getFullYear(), fechaIni.getMonth(), 1);

    while (fechaActual <= fechaFin) {
      const año = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
      const fechaVenc = `${año}-${mes}-01`;

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

      fechaActual.setMonth(fechaActual.getMonth() + 1);
    }

    res.redirect('/alumnos/' + alumno_id);
  } catch (err) {
    console.error('Error al generar cuotas:', err);
    res.status(500).send('Error al generar cuotas');
  }
});

// GET: Formulario nuevo pago
router.get('/nuevo/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;
  try {
    const result = await db.query('SELECT * FROM alumnos WHERE id = $1', [alumnoId]);
    if (result.rows.length === 0) return res.status(404).send('Alumno no encontrado');
    // Aquí podrías renderizar un formulario si lo necesitas
    res.send('Formulario nuevo pago (pendiente de implementación)');
  } catch (err) {
    res.status(500).send('Error al buscar alumno');
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
  const pagoId = req.params.id;

  try {
    const result = await db.query(`
      SELECT p.*, a.nombre, a.apellidos, a.id AS alumno_id
      FROM pagos p
      JOIN alumnos a ON a.id = p.alumno_id
      WHERE p.id = $1
    `, [pagoId]);

    if (result.rows.length === 0) return res.status(404).send('Pago no encontrado');
    const pago = result.rows[0];

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo_pago_${pago.id}.pdf"`);

    doc.pipe(res);

    doc.fontSize(20).text('Recibo de Pago', { align: 'center' }).moveDown();
    doc.fontSize(12)
      .text(`Alumno: ${pago.nombre} ${pago.apellidos}`)
      .text(`ID Alumno: ${pago.alumno_id}`)
      .text(`Fecha de pago: ${pago.fecha_pago}`)
      .text(`Importe: ${parseFloat(pago.importe).toFixed(2)} €`)
      .text(`Medio de pago: ${pago.medio_pago}`)
      .text(`Referencia: ${pago.referencia || '—'}`)
      .text(`Observaciones: ${pago.observaciones || '—'}`);

    doc.end();
  } catch (err) {
    console.error('❌ Error generando recibo:', err.message);
    res.status(500).send('Error al generar recibo');
  }
});

module.exports = router;