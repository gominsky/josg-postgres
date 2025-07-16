const express = require('express');
const router = express.Router();
const db = require('../database/db'); // o ajustá la ruta si es distinta
const PDFDocument = require('pdfkit');
router.post('/', (req, res) => {
  const { alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones } = req.body;

  // Paso 1: Insertar el pago
  db.run(`
    INSERT INTO pagos (alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [alumno_id, importe, fecha_pago, medio_pago, referencia, observaciones], function (err) {
    if (err) return res.status(500).send('Error al registrar el pago');

    const pagoId = this.lastID;
    let restante = parseFloat(importe);

    // Paso 2: Buscar cuotas no pagadas del alumno
    db.all(`
      SELECT ca.id, c.precio AS importe_cuota
      FROM cuotas_alumno ca
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE ca.alumno_id = ? AND ca.pagado = 0
      ORDER BY ca.fecha_vencimiento ASC
    `, [alumno_id], (err2, cuotas) => {
      if (err2) return res.status(500).send('Error al buscar cuotas');

      const aplicarPagoACuotas = (index = 0) => {
        if (index >= cuotas.length || restante <= 0) return res.redirect('/alumnos/' + alumno_id);

        const cuota = cuotas[index];
        const cuotaId = cuota.id;
        const importeCuota = cuota.importe_cuota;

        const aplicar = Math.min(restante, importeCuota);
        restante -= aplicar;

        db.run(`
          INSERT INTO pago_cuota_alumno (pago_id, cuota_alumno_id, importe_aplicado)
          VALUES (?, ?, ?)
        `, [pagoId, cuotaId, aplicar], function (err3) {
          if (err3) return res.status(500).send('Error al aplicar pago a cuota');

          // Verificar si la cuota queda totalmente pagada
          db.get(`
            SELECT SUM(importe_aplicado) AS total_pagado
            FROM pago_cuota_alumno
            WHERE cuota_alumno_id = ?
          `, [cuotaId], (err4, row) => {
            if (err4) return res.status(500).send('Error al verificar pago total');

            if (row.total_pagado >= importeCuota) {
              db.run(`
                UPDATE cuotas_alumno
                SET pagado = 1, fecha_pago = ?
                WHERE id = ?
              `, [fecha_pago, cuotaId], () => aplicarPagoACuotas(index + 1));
            } else {
              aplicarPagoACuotas(index + 1);
            }
          });
        });
      };

      aplicarPagoACuotas();
    });
  });
});

router.get('/nuevo/:alumnoId', (req, res) => {
  const alumnoId = req.params.alumnoId;

  db.get('SELECT * FROM alumnos WHERE id = ?', [alumnoId], (err, alumno) => {
    if (err || !alumno) return res.status(404).send('Alumno no encontrado');

    db.all('SELECT i.nombre FROM instrumentos i JOIN alumno_instrumento ai ON i.id = ai.instrumento_id WHERE ai.alumno_id = ?', [alumnoId], (err2, instrumentos = []) => {
      db.all('SELECT g.nombre FROM grupos g JOIN alumno_grupo ag ON g.id = ag.grupo_id WHERE ag.alumno_id = ?', [alumnoId], (err3, grupos = []) => {
        db.all('SELECT * FROM cuotas ORDER BY nombre', (err4, cuotasDisponibles = []) => {
          db.all(`
            SELECT 
              ca.*, 
              c.nombre AS nombre_cuota, 
              c.precio 
            FROM cuotas_alumno ca
            JOIN cuotas c ON ca.cuota_id = c.id
            WHERE ca.alumno_id = ?
            ORDER BY ca.fecha_vencimiento ASC
          `, [alumnoId], (err5, cuotasAlumno = []) => {
            db.all(`
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
              WHERE p.alumno_id = ?
              ORDER BY p.fecha_pago DESC
            `, [alumnoId], (err6, pagos = []) => {

              res.render('pago_form', {
                alumno: {
                  ...alumno,
                  instrumentos: instrumentos.map(i => i.nombre).join(', '),
                  grupos: grupos.map(g => g.nombre).join(', ')
                },
                pagos,
                cuotasDisponibles,
                cuotasAlumno
              });

            });
          });
        });
      });
    });
  });
});

router.post('/generar-cuotas', (req, res) => {
  const { alumno_id, cuota_id, fecha_inicio, fecha_fin } = req.body;

  const fechaIni = new Date(fecha_inicio);
  const fechaFin = new Date(fecha_fin);

  const cuotasInsertadas = [];

  const insertarCuotasRecursivo = (fechaActual) => {
    if (fechaActual > fechaFin) {
      return res.redirect('/alumnos/' + alumno_id);
    }

    const año = fechaActual.getFullYear();
    const mes = fechaActual.getMonth() + 1;
    const fechaVenc = `${año}-${mes.toString().padStart(2, '0')}-01`;

    // Verificar si ya existe una cuota para ese alumno, mes y tipo
    db.get(`
      SELECT 1 FROM cuotas_alumno
      WHERE alumno_id = ? AND cuota_id = ? AND fecha_vencimiento = ?
    `, [alumno_id, cuota_id, fechaVenc], (err, existente) => {
      if (err) return res.status(500).send('Error verificando cuotas');

      if (!existente) {
        db.run(`
          INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
          VALUES (?, ?, ?, 0)
        `, [alumno_id, cuota_id, fechaVenc], (err2) => {
          if (err2) return res.status(500).send('Error al generar cuota');
        });
      }

      // Siguiente mes
      fechaActual.setMonth(fechaActual.getMonth() + 1);
      insertarCuotasRecursivo(fechaActual);
    });
  };

  insertarCuotasRecursivo(new Date(fechaIni.getFullYear(), fechaIni.getMonth(), 1));
});
 
// GET: Ficha alumno
router.get('/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM alumnos WHERE id = ?', [id], (err, alumno) => {
    if (err || !alumno) return res.status(404).send('Alumno no encontrado');

    const pagosQuery = `
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
WHERE p.alumno_id = ?
ORDER BY p.fecha_pago DESC
    `;

    db.all(pagosQuery, [id], (errPagos, pagos) => {
      if (errPagos) pagos = [];

      db.all('SELECT i.nombre FROM instrumentos i JOIN alumno_instrumento ai ON i.id = ai.instrumento_id WHERE ai.alumno_id = ?', [id], (err2, instrumentos) => {
        if (err2) instrumentos = [];

        db.all('SELECT g.nombre FROM grupos g JOIN alumno_grupo ag ON g.id = ag.grupo_id WHERE ag.alumno_id = ?', [id], (err3, grupos) => {
          if (err3) grupos = [];

          db.all('SELECT * FROM cuotas ORDER BY nombre', (err4, cuotasDisponibles) => {
            if (err4) cuotasDisponibles = [];

            res.render('alumnos_ficha', {
              alumno: {
                ...alumno,
                instrumentos: instrumentos.map(i => i.nombre).join(', '),
                grupos: grupos.map(g => g.nombre).join(', ')
              },
              pagos,
              cuotasDisponibles
            });
          });
        });
      });
    });
  });
});

router.get('/:id/recibo', (req, res) => {
  const pagoId = req.params.id;

  db.get(`
    SELECT p.*, a.nombre, a.apellidos, a.id AS alumno_id
    FROM pagos p
    JOIN alumnos a ON a.id = p.alumno_id
    WHERE p.id = ?
  `, [pagoId], (err, pago) => {
    if (err || !pago) return res.status(404).send('Pago no encontrado');

    const doc = new PDFDocument();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo_pago_${pago.id}.pdf"`);

    doc.pipe(res);

    doc.fontSize(20).text('Recibo de Pago', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12)
      .text(`Alumno: ${pago.nombre} ${pago.apellidos}`)
      .text(`ID Alumno: ${pago.alumno_id}`)
      .text(`Fecha de pago: ${pago.fecha_pago}`)
      .text(`Importe: ${pago.importe.toFixed(2)} €`)
      .text(`Medio de pago: ${pago.medio_pago}`)
      .text(`Referencia: ${pago.referencia || '—'}`)
      .text(`Observaciones: ${pago.observaciones || '—'}`);

    doc.end();
  });
});
   
module.exports = router; 