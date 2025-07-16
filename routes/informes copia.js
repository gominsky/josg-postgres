// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');
const util = require('util'); 

// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/lista');
});

// Formulario inicial
router.get('/ficha', (req, res) => {
  db.all('SELECT * FROM grupos ORDER BY nombre', (err1, grupos) => {
    if (err1) return res.status(500).send('Error al cargar grupos');
    db.all('SELECT * FROM instrumentos ORDER BY nombre', (err2, instrumentos) => {
      if (err2) return res.status(500).send('Error al cargar instrumentos');
      res.render('informe_form', {
        grupos,
        instrumentos,
        profesores: [], // <- vacío ya que no se usa
        alumnos: [],
        campos: [],
        grupoSeleccionado: null,
        instrumentoSeleccionado: null,
        profesorSeleccionado: null,
        nombreInforme: '',
        fechaHoy: new Date().toISOString().split('T')[0]
      });
    });
  });
});

// Filtrar alumnos y campos
router.post('/ficha/filtrar', (req, res) => {
  const { grupo_id, instrumento_id, nombre_informe, fecha } = req.body;

  if (grupo_id === 'ninguno') {
    return db.all('SELECT * FROM grupos ORDER BY nombre', (_, grupos) => {
      db.all('SELECT * FROM instrumentos ORDER BY nombre', (_, instrumentos) => {
        res.render('informe_form', {
          grupos,
          instrumentos,
          profesores: [],
          alumnos: [], // sin alumnos
          campos: [],
          grupoSeleccionado: grupo_id,
          instrumentoSeleccionado: instrumento_id,
          profesorSeleccionado: null,
          nombreInforme: nombre_informe,
          fechaHoy: fecha || new Date().toISOString().split('T')[0]
        });
      });
    });
  }

  let sql = `
    SELECT DISTINCT a.id, a.nombre, a.apellidos
    FROM alumnos a
    JOIN alumno_grupo ag ON a.id = ag.alumno_id
    JOIN alumno_instrumento ai ON a.id = ai.alumno_id
    WHERE a.activo = 1
  `;

  const params = [];

  if (grupo_id !== 'todos') {
    sql += ` AND ag.grupo_id = ?`;
    params.push(grupo_id);
  }

  if (instrumento_id !== 'todos') {
    sql += ` AND ai.instrumento_id = ?`;
    params.push(instrumento_id);
  }

  sql += ' ORDER BY a.apellidos, a.nombre';

  db.all(sql, params, (err, alumnos) => {
    if (err) return res.status(500).send('Error al cargar alumnos');

    db.all('SELECT * FROM grupos ORDER BY nombre', (_, grupos) => {
      db.all('SELECT * FROM instrumentos ORDER BY nombre', (_, instrumentos) => {
        res.render('informe_form', {
          grupos,
          instrumentos,
          profesores: [],
          alumnos,
          campos: [],
          grupoSeleccionado: grupo_id,
          instrumentoSeleccionado: instrumento_id,
          profesorSeleccionado: null,
          nombreInforme: nombre_informe,
          fechaHoy: fecha || new Date().toISOString().split('T')[0]
        });
      });
    });
  });
});

router.post('/ficha/guardar-json', (req, res) => {
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    resultados,
    campos_json
  } = req.body;

  const parsedResultados = JSON.parse(resultados || '[]');
  const parsedCampos = JSON.parse(campos_json || '[]');

  const grupoIdFinal = grupo_id === 'ninguno' ? null : grupo_id;
  const instrumentoIdFinal = instrumento_id === 'ninguno' ? null : instrumento_id;

  db.run(`
    INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
    VALUES (?, ?, ?, ?)
  `, [nombre_informe, grupoIdFinal, instrumentoIdFinal, fecha], function (err) {
    if (err) {
      return res.status(500).send('Error al guardar informe');
    }

    const informeId = this.lastID;

    const campoInsert = db.prepare(`
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES (?, ?, ?, ?)
    `);

    const campoIDPromises = parsedCampos.map((campo, index) => {
      return new Promise((resolve, reject) => {
        campoInsert.run(informeId, campo.nombre, campo.tipo, campo.obligatorio, function (err) {
          if (err) return reject(err);
          parsedCampos[index].id = this.lastID;
          resolve();
        });
      });
    });

    Promise.all(campoIDPromises)
      .then(() => {
        campoInsert.finalize();

        const resultadoInsert = db.prepare(`
          INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor, fila)
          VALUES (?, ?, ?, ?, ?)
        `);

        parsedResultados.forEach((r, i) => {
          const campo = parsedCampos[r.campo_index];
          if (!campo) {
            console.warn(`⚠️ Resultado [${i}] no tiene campo válido`, r);
            return;
          }
          if (!campo.id) {
            console.warn(`⚠️ Campo sin ID:`, campo);
            return;
          }

          console.log(`💾 Insertando resultado:`, {
            informe_id: informeId,
            alumno_id: r.alumno_id,
            campo_id: campo.id,
            valor: r.valor,
            fila: r.fila ?? null
          });

          resultadoInsert.run(informeId, r.alumno_id, campo.id, r.valor, r.fila ?? null);
        });

        resultadoInsert.finalize(() => {
          res.redirect('/informes/lista');
        });
      })
      .catch(err => {
        console.error(err);
        res.status(500).send('Error al guardar campos');
      });
  });
});

// Listado
router.get('/lista', (req, res) => {
  db.all(`
    SELECT inf.id, inf.informe, inf.fecha,
           g.nombre AS grupo,
           i.nombre AS instrumento
    FROM informes inf
    LEFT JOIN grupos g ON inf.grupo_id = g.id
    LEFT JOIN instrumentos i ON inf.instrumento_id = i.id
    ORDER BY inf.fecha DESC
  `, [], (err, informes) => {
    if (err) return res.status(500).send('Error al cargar informes');

    informes.forEach(i => {
      if (i.grupo === null) {
        i.grupo = 'Ninguno';
      }
      if (i.instrumento === null) {
        i.instrumento = 'Ninguno';
      }
    });

    res.render('informes_lista', { informes });
  });
});


router.get('/ver/:id', (req, res) => {
  const id = req.params.id;

  const sqlInforme = `
    SELECT i.*, g.nombre AS grupo, inst.nombre AS instrumento,
           p.nombre || ' ' || p.apellidos AS profesor
    FROM informes i
    LEFT JOIN grupos g ON i.grupo_id = g.id
    LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
    LEFT JOIN profesores p ON i.profesor_id = p.id
    WHERE i.id = ?
  `;

  const sqlCampos = `SELECT * FROM informe_campos WHERE informe_id = ? ORDER BY id`;

  const sqlResultados = `
    SELECT ir.*, a.nombre, a.apellidos
    FROM informe_resultados ir
    LEFT JOIN alumnos a ON ir.alumno_id = a.id
    WHERE ir.informe_id = ?
    AND (a.id IS NULL OR a.activo = 1)
  `;

  db.get(sqlInforme, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    db.all(sqlCampos, [id], (errCampos, campos) => {
      if (errCampos) return res.status(500).send('Error al obtener campos');

      db.all(sqlResultados, [id], (errResultados, resultados) => {
        if (errResultados) return res.status(500).send('Error al obtener resultados');

        // Agrupar resultados en filas
        const filasMap = {};
        resultados.forEach(r => {
          const clave = r.alumno_id !== null ? `a_${r.alumno_id}` : `f_${r.fila}`;
          if (!filasMap[clave]) {
            filasMap[clave] = {
              alumno_id: r.alumno_id,
              fila: r.fila,
              nombre: r.nombre || '',
              apellidos: r.apellidos || '',
              valores: {}
            };
          }
          filasMap[clave].valores[r.campo_id] = r.valor;
        });

        const filas = Object.values(filasMap).sort((a, b) => {
          if (a.alumno_id && b.alumno_id) {
            return a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre);
          } else if (!a.alumno_id && !b.alumno_id) {
            return (a.fila || 0) - (b.fila || 0);
          } else {
            return a.alumno_id ? -1 : 1;
          }
        });

        res.render('informes_ficha', {
          informe,
          campos,
          filas
        });
      });
    });
  });
});

router.get('/editar/:id', (req, res) => {
  const id = req.params.id;

  const sqlInforme = `
    SELECT i.*, g.nombre AS grupo, inst.nombre AS instrumento,
           p.nombre || ' ' || p.apellidos AS profesor
    FROM informes i
    LEFT JOIN grupos g ON i.grupo_id = g.id
    LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
    LEFT JOIN profesores p ON i.profesor_id = p.id
    WHERE i.id = ?
  `;

  const sqlCampos = `SELECT * FROM informe_campos WHERE informe_id = ?`;
  const sqlResultados = `
    SELECT ir.*, a.nombre, a.apellidos
    FROM informe_resultados ir
    LEFT JOIN alumnos a ON ir.alumno_id = a.id
    WHERE ir.informe_id = ?
    AND (a.id IS NULL OR a.activo = 1)
    ORDER BY 
      CASE WHEN a.id IS NULL THEN 1 ELSE 0 END,
      a.apellidos, a.nombre,
      ir.fila
  `;

  db.get(sqlInforme, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    db.all(sqlCampos, [id], (errCampos, campos) => {
      if (errCampos) return res.status(500).send('Error al obtener campos');

      db.all(sqlResultados, [id], (errResultados, resultados) => {
        if (errResultados) return res.status(500).send('Error al obtener resultados');

        const filasMap = resultados
          .filter(r => r.alumno_id === null)
          .reduce((acc, r) => {
            const idx = r.fila != null ? r.fila : 0;
            acc[idx] = acc[idx] || {};
            acc[idx][r.campo_id] = r.valor;
            return acc;
          }, {});
        const numFilasIniciales = Object.keys(filasMap).length;

        res.render('informes_editar', {
          informe,
          campos,
          resultados,
          filasMap,
          numFilasIniciales
        });
      });
    });
  });
});

router.post('/editar/:id', (req, res) => {
  const informe_id = req.params.id;
  const resultados = JSON.parse(req.body.resultados || '[]');

  console.log("📥 Recibidos en edición:", resultados);

  db.serialize(() => {
    db.run('DELETE FROM informe_resultados WHERE informe_id = ?', [informe_id], (err) => {
      if (err) {
        console.error('Error al eliminar anteriores:', err);
        return res.status(500).send('Error al eliminar resultados previos');
      }

      const stmt = db.prepare(`
        INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor, fila)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const r of resultados) {
        const alumnoId = r.alumno_id === null || r.alumno_id === undefined ? null : r.alumno_id;
        stmt.run(informe_id, alumnoId, r.campo_id, r.valor, r.fila ?? null);
      }

      stmt.finalize(err => {
        if (err) {
          console.error('Error al guardar resultados:', err);
          return res.status(500).send('Error al guardar resultados');
        }
        res.redirect(`/informes/ver/${informe_id}`);
      });
    });
  });
});

router.post('/eliminar/:id', (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM informe_resultados WHERE informe_id = ?`, [id], (err1) => {
    if (err1) return res.status(500).send('Error al eliminar resultados');

    db.run(`DELETE FROM informe_campos WHERE informe_id = ?`, [id], (err2) => {
      if (err2) return res.status(500).send('Error al eliminar campos');

      db.run(`DELETE FROM informes WHERE id = ?`, [id], (err3) => {
        if (err3) return res.status(500).send('Error al eliminar informe');
        res.redirect('/informes/lista');
      });
    });
  });
});

// PDF combinado
router.get('/pdf/combinado', (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).send('IDs no proporcionados');

  const idArray = ids.split(',').map(Number).filter(Boolean);
  if (idArray.length === 0) return res.status(400).send('IDs inválidos');

  const placeholders = idArray.map(() => '?').join(',');
  const sql = `
    SELECT inf.id, inf.informe, inf.fecha,
           g.nombre AS grupo, i.nombre AS instrumento,
           pr.nombre || ' ' || pr.apellidos AS profesor
    FROM informes inf
    LEFT JOIN grupos g ON inf.grupo_id = g.id
    LEFT JOIN instrumentos i ON inf.instrumento_id = i.id
    LEFT JOIN profesores pr ON inf.profesor_id = pr.id
    WHERE inf.id IN (${placeholders})
  `;

  db.all(sql, idArray, (err, informes) => {
    if (err || !informes.length) return res.status(404).send('No se encontraron informes');
    db.all(`
      SELECT ir.informe_id, a.nombre, a.apellidos, ic.nombre AS campo, ir.valor
      FROM informe_resultados ir
      JOIN alumnos a ON a.id = ir.alumno_id
      JOIN informe_campos ic ON ic.id = ir.campo_id
      WHERE ir.informe_id IN (${placeholders})
        AND a.activo = 1
      ORDER BY a.apellidos, a.nombre
    `, idArray, (err2, resultados) => {
      if (err2) return res.status(500).send('Error al cargar resultados');

      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="informes_combinados.pdf"');
      doc.pipe(res);

      informes.forEach((inf, idx) => {
        if (idx > 0) doc.addPage();
        doc.fontSize(16).text(`Informe: ${inf.informe}`, { underline: true });
        doc.moveDown();
        doc.fontSize(12)
          .text(`Fecha: ${inf.fecha}`)
          .text(`Grupo: ${inf.grupo}`)
          .text(`Instrumento: ${inf.instrumento}`)
          .text(`Profesor: ${inf.profesor}`);
        doc.moveDown();

        const items = resultados.filter(r => r.informe_id === inf.id);
        if (items.length) {
          items.forEach(r => {
            doc.text(`${r.apellidos}, ${r.nombre} | ${r.campo}: ${r.valor}`);
          });
        } else {
          doc.text('Sin resultados.');
        }
      });

      doc.end();
    });
  });
});

// PDF individual
router.get('/pdf/:id', (req, res) => {
  const id = parseInt(req.params.id);

  db.get(`
    SELECT inf.*, g.nombre AS grupo, i.nombre AS instrumento,
           pr.nombre || ' ' || pr.apellidos AS profesor
    FROM informes inf
    LEFT JOIN grupos g ON inf.grupo_id = g.id
    LEFT JOIN instrumentos i ON inf.instrumento_id = i.id
    LEFT JOIN profesores pr ON inf.profesor_id = pr.id
    WHERE inf.id = ?
  `, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');
    db.all(`
      SELECT a.nombre, a.apellidos, ic.nombre AS campo, ir.valor
      FROM informe_resultados ir
      JOIN alumnos a ON a.id = ir.alumno_id
      JOIN informe_campos ic ON ic.id = ir.campo_id
      WHERE ir.informe_id = ?
        AND a.activo = 1
      ORDER BY a.apellidos, a.nombre
    `, [id], (err2, resultados) => {
      if (err2) return res.status(500).send('Error al cargar resultados');

      const doc = new PDFDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="informe_${id}.pdf"`);
      doc.pipe(res);

      doc.fontSize(18).text(`Informe: ${informe.informe}`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(12)
        .text(`Fecha: ${informe.fecha}`)
        .text(`Grupo: ${informe.grupo || 'Todos'}`)
        .text(`Instrumento: ${informe.instrumento || 'Todos'}`)
        .text(`Profesor: ${informe.profesor || '—'}`);
      doc.moveDown();

      resultados.forEach(r => {
        doc.text(`${r.apellidos}, ${r.nombre} | ${r.campo}: ${r.valor}`);
      });

      doc.end();
    });
  });
});

module.exports = router;



