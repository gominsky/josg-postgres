const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');
const path = require('path');
function drawFooter(doc) {
  const now = new Date();
  const fecha = `${now.getDate()} de ${now.toLocaleString('es-ES', { month: 'long' })} de ${now.getFullYear()}`;

  doc.moveTo(40, 730).lineTo(555, 730).stroke();

  doc.fontSize(9).fillColor('gray').text(`Granada, ${fecha}`, 40, 735);
  doc.fontSize(7).fillColor('gray').text(
    `Asociación Joven Orquesta de Granada\n` +
    `CIF: G-18651067 · www.josg.org · Tfno: 682445971\n` +
    `C/ Andrés Segovia 60, 18007 Granada\n` +
    `Sede de ensayos: Teatro Maestro Francisco Alonso, C/ Ribera del Beiro 34, 18012 Granada`,
    40, 750
  );
}
function drawHeader(doc) {
  const margin = 40;
  const top = 30;

  // Recuadro superior
  doc.rect(margin, top, 515, 80).fill('#f2f2f2').stroke();

  // Logo
  const logoPath = path.join(__dirname, '..', 'public', 'imagenes', 'logoJosg.png');
  try {
    doc.image(logoPath, margin + 10, top + 10, { width: 60 });
  } catch (e) {
    console.warn('⚠️ Logo no encontrado en', logoPath);
  }

  // Datos a la derecha
  doc.fillColor('black')
    .font('Helvetica-Bold').fontSize(10)
    .text('Asociación Joven Orquesta de Granada', margin + 80, top + 10, { align: 'left' });

  doc.font('Helvetica').fontSize(8)
    .text('CIF: G-18651067', margin + 80, top + 24)
    .text('www.josg.org', margin + 80, top + 36)
}
function generarReciboPago(doc, pago, cuotas) {
  const margin = 40;
  const lineHeight = 20;
  const cellPadding = 5;
  const col1Width = 120;
  const col2Width = 350;

  drawHeader(doc);
  doc.moveDown(3);
  doc.moveDown(4); // Baja antes de escribir el título
  doc.fontSize(16).font('Helvetica-Bold').text('RECIBO DE PAGO', { align: 'center' }).moveDown(2);
  // --- Tabla: Datos del alumno ---
  doc.fontSize(12).font('Helvetica-Bold').text('Datos del alumno', { align: 'left' }).moveDown(0.5);
  drawKeyValueTable(doc, [
    ['Nombre', `${pago.nombre_alumno} ${pago.apellidos}`],
    ['DNI', pago.dni || '—'],
    ['Email', pago.email || '—']
  ], { x: margin, y: doc.y, col1Width, col2Width, lineHeight, cellPadding });

  doc.moveDown(1.5);

  // --- Tabla: Detalles del pago ---
  doc.fontSize(12).font('Helvetica-Bold').text('Detalles del pago', { align: 'left' }).moveDown(0.5);
  drawKeyValueTable(doc, [
    ['Fecha', new Date(pago.fecha_pago).toLocaleDateString('es-ES')],
    ['Medio de pago', pago.medio_pago],
    ['Referencia', pago.referencia || '—']
  ], { x: margin, y: doc.y, col1Width, col2Width, lineHeight, cellPadding });

  doc.moveDown(1.5);

  // --- Tabla: Cuotas cubiertas ---
  doc.fontSize(12).font('Helvetica-Bold').text('Cuotas cubiertas').moveDown(0.5);
  if (cuotas.length > 0) {
    cuotas.forEach((c, i) => {
      doc.font('Helvetica').fontSize(10).text(
        `${i + 1}. ${c.cuota_nombre} (${new Date(c.fecha_vencimiento).toLocaleDateString('es-ES')}) - ${Number(c.importe_aplicado).toFixed(2)} €`
      );
    });
  } else {
    doc.font('Helvetica').fontSize(10).text('No se encontraron cuotas asociadas.');
  }

  doc.moveDown(2);

  // --- Total pagado ---
  doc.moveTo(margin, doc.y).lineTo(555, doc.y).stroke().moveDown(0.5);
  const total = parseFloat(pago.importe_pago || 0);
  doc.fontSize(14).font('Helvetica-Bold').text(`Total pagado: ${total.toFixed(2)} €`, margin);

  drawFooter(doc);
}
function drawKeyValueTable(doc, rows, { x, y, col1Width, col2Width, lineHeight, cellPadding }) {
  rows.forEach(([label, value], index) => {
    const yOffset = y + index * lineHeight;

    // Columna 1: Etiqueta
    doc.rect(x, yOffset, col1Width, lineHeight).stroke();
    doc.font('Helvetica-Bold').fontSize(10).text(label, x + cellPadding, yOffset + cellPadding, {
      width: col1Width - 2 * cellPadding,
      height: lineHeight - 2 * cellPadding
    });

    // Columna 2: Valor
    doc.rect(x + col1Width, yOffset, col2Width, lineHeight).stroke();
    doc.font('Helvetica').fontSize(10).text(value, x + col1Width + cellPadding, yOffset + cellPadding, {
      width: col2Width - 2 * cellPadding,
      height: lineHeight - 2 * cellPadding
    });
  });

  doc.y = y + rows.length * lineHeight;
}

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
    res.redirect('/alumnos/' + alumno_id + '?tab=finanzas');
  } catch (err) {
    console.error('❌ Error al registrar pago:', err.message);
    res.status(500).send('Error al registrar el pago');
  }
});
router.get('/nuevo/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;

  try {
    const alumnoRes = await db.query(`SELECT * FROM alumnos WHERE id = $1`, [alumnoId]);
    const alumno = alumnoRes.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const [instrumentosRes, gruposRes, cuotasDisponiblesRes, cuotasAlumnoRes, pagosRes] = await Promise.all([
      db.query(`
        SELECT i.nombre
        FROM instrumentos i
        JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = $1
      `, [alumnoId]),
      db.query(`
        SELECT g.nombre
        FROM grupos g
        JOIN alumno_grupo ag ON g.id = ag.grupo_id
        WHERE ag.alumno_id = $1
      `, [alumnoId]),
      db.query(`SELECT * FROM cuotas ORDER BY nombre`),
      db.query(`
        SELECT 
          ca.*, 
          c.nombre AS nombre_cuota, 
          c.precio
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
        ORDER BY ca.fecha_vencimiento ASC
      `, [alumnoId]),
      db.query(`
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
      `, [alumnoId])
    ]);

    const instrumentos = instrumentosRes.rows.map(i => i.nombre).join(', ');
    const grupos = gruposRes.rows.map(g => g.nombre).join(', ');

    res.render('pago_form', {
      alumno: {
        ...alumno,
        instrumentos,
        grupos
      },
      pagos: pagosRes.rows,
      cuotasDisponibles: cuotasDisponiblesRes.rows,
      cuotasAlumno: cuotasAlumnoRes.rows
    });

  } catch (err) {
    console.error('❌ Error cargando formulario de pagos:', err);
    res.status(500).send('Error cargando datos');
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
    res.setHeader('Content-Disposition', `inline; filename="recibo_${pago.id}.pdf"`);

    generarReciboPago(doc, pago, cuotas);
    doc.pipe(res);
    doc.end();

  } catch (err) {
    console.error('❌ Error al generar recibo:', err.message);
    res.status(500).send('Error al generar el recibo');
  }
});



module.exports = router;