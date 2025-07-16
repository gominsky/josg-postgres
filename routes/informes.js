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
        profesores: [],
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

// Edición
router.get('/ficha/:id', (req, res) => {
  const id = req.params.id;
  db.get(`SELECT * FROM informes WHERE id = ?`, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    db.all('SELECT * FROM grupos ORDER BY nombre', (_, grupos) => {
      db.all('SELECT * FROM instrumentos ORDER BY nombre', (_, instrumentos) => {
        db.all('SELECT * FROM informe_campos WHERE informe_id = ?', [id], (errCampos, campos) => {
          if (errCampos) return res.status(500).send('Error al obtener campos');

          db.all(`
            SELECT ir.*, a.nombre, a.apellidos
            FROM informe_resultados ir
            LEFT JOIN alumnos a ON ir.alumno_id = a.id
            WHERE ir.informe_id = ?
            AND (a.id IS NULL OR a.activo = 1)
          `, [id], (errResultados, resultados) => {
            if (errResultados) return res.status(500).send('Error al obtener resultados');

            const grupoSeleccionado = informe.grupo_id ?? 'ninguno';
            const instrumentoSeleccionado = informe.instrumento_id ?? 'ninguno';

            const alumnos = resultados.filter(r => r.alumno_id).map(r => ({
              id: r.alumno_id,
              nombre: r.nombre,
              apellidos: r.apellidos
            })).filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

            res.render('informe_form', {
              informeId: id,
              nombreInforme: informe.informe,
              grupoSeleccionado,
              instrumentoSeleccionado,
              profesorSeleccionado: null,
              fechaHoy: informe.fecha,
              grupos,
              instrumentos,
              campos,
              alumnos,
              resultados
            });
          });
        });
      });
    });
  });
});

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

router.post('/ficha/guardar-json', (req, res) => {
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    resultados,
    campos_json,
    informeId
  } = req.body;

  const parsedResultados = JSON.parse(resultados || '[]');
  const parsedCampos = JSON.parse(campos_json || '[]');

  const grupoIdFinal = grupo_id === 'ninguno' ? null : grupo_id;
  const instrumentoIdFinal = instrumento_id === 'ninguno' ? null : instrumento_id;

  const guardarResultadosYCampos = (informeIdFinal) => {
    db.run(`DELETE FROM informe_resultados WHERE informe_id = ?`, [informeIdFinal], (err1) => {
      if (err1) return res.status(500).send('Error al limpiar resultados anteriores');

      db.run(`DELETE FROM informe_campos WHERE informe_id = ?`, [informeIdFinal], (err2) => {
        if (err2) return res.status(500).send('Error al limpiar campos anteriores');

        const campoInsert = db.prepare(`
          INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
          VALUES (?, ?, ?, ?)
        `);

        const campoIDPromises = parsedCampos.map((campo, index) => {
          return new Promise((resolve, reject) => {
            campoInsert.run(informeIdFinal, campo.nombre, campo.tipo, campo.obligatorio, function (err) {
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
              if (!campo || !campo.id) return;

              resultadoInsert.run(informeIdFinal, r.alumno_id || null, campo.id, r.valor, r.fila ?? null);
            });

            resultadoInsert.finalize(() => {
              res.redirect('/informes/lista');
            });
          })
          .catch(err => {
            console.error('❌ Error al guardar campos/resultados:', err);
            res.status(500).send('Error al guardar informe');
          });
      });
    });
  };

  // 🚩 Si se está editando un informe existente
  if (informeId) {
    db.run(`
      UPDATE informes SET informe = ?, grupo_id = ?, instrumento_id = ?, fecha = ?
      WHERE id = ?
    `, [nombre_informe, grupoIdFinal, instrumentoIdFinal, fecha, informeId], function (err) {
      if (err) return res.status(500).send('Error al actualizar informe');
      guardarResultadosYCampos(informeId);
    });

  } else {
    // 🆕 Si es un nuevo informe
    db.run(`
      INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
      VALUES (?, ?, ?, ?)
    `, [nombre_informe, grupoIdFinal, instrumentoIdFinal, fecha], function (err) {
      if (err) return res.status(500).send('Error al guardar informe nuevo');
      guardarResultadosYCampos(this.lastID);
    });
  }
});

router.get('/detalle/:id', (req, res) => {
  const id = req.params.id;

  db.get(`
  SELECT i.*, g.nombre AS grupo, inst.nombre AS instrumento
  FROM informes i
  LEFT JOIN grupos g ON i.grupo_id = g.id
  LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
  WHERE i.id = ?
`, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    db.all(`SELECT * FROM informe_campos WHERE informe_id = ? ORDER BY id`, [id], (errCampos, campos) => {
      if (errCampos) return res.status(500).send('Error al obtener campos');

      db.all(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = ?
        AND (a.id IS NULL OR a.activo = 1)
      `, [id], (errResultados, resultados) => {
        if (errResultados) return res.status(500).send('Error al obtener resultados');

        // Agrupar por alumno o fila
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

        const tieneAlumnos = filas.some(f => f.alumno_id !== null);

        res.render('informes_detalle', {
          informe,
          campos,
          filas,
          tieneAlumnos
        });
      });
    });
  });
});
router.post('/detalle/:id', (req, res) => {
  const id = req.params.id;
  const resultados = JSON.parse(req.body.resultados || '[]');

  db.run('DELETE FROM informe_resultados WHERE informe_id = ?', [id], (err1) => {
    if (err1) return res.status(500).send('Error al limpiar resultados anteriores');

    const stmt = db.prepare(`
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor, fila)
      VALUES (?, ?, ?, ?, ?)
    `);

    resultados.forEach(r => {
      stmt.run(id, r.alumno_id, r.campo_id, r.valor, r.fila ?? null);
    });

    stmt.finalize(err2 => {
      if (err2) return res.status(500).send('Error al guardar resultados');
      res.redirect('/informes/lista');
    });
  });
});
router.post('/ficha/filtrar', (req, res) => {
  const { grupo_id, instrumento_id, nombre_informe, fecha } = req.body;

  // Si es un informe sin alumnos
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

  // Consulta para informe con alumnos
  let sql = `
    SELECT DISTINCT a.id, a.nombre, a.apellidos
    FROM alumnos a
    JOIN alumno_grupo ag ON a.id = ag.alumno_id
    JOIN alumno_instrumento ai ON a.id = ai.alumno_id
    WHERE a.activo = 1
  `;

  const params = [];

  if (grupo_id !== 'todos') {
    sql += ' AND ag.grupo_id = ?';
    params.push(grupo_id);
  }

  if (instrumento_id !== 'todos' && instrumento_id !== 'ninguno') {
    sql += ' AND ai.instrumento_id = ?';
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

router.get('/pdf/:id', (req, res) => {
  const id = req.params.id;

  db.get(`SELECT * FROM informes WHERE id = ?`, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    db.all(`SELECT * FROM informe_campos WHERE informe_id = ? ORDER BY id`, [id], (errCampos, campos) => {
      if (errCampos) return res.status(500).send('Error al obtener campos');

      db.all(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = ?
        AND (a.id IS NULL OR a.activo = 1)
      `, [id], (errResultados, resultados) => {
        if (errResultados) return res.status(500).send('Error al obtener resultados');

        const filasMap = {};
        resultados.forEach(r => {
          const clave = r.alumno_id !== null ? `a_${r.alumno_id}` : `f_${r.fila}`;
          if (!filasMap[clave]) {
            filasMap[clave] = {
              alumno: r.apellidos && r.nombre ? `${r.apellidos}, ${r.nombre}` : '-',
              valores: {}
            };
          }
          filasMap[clave].valores[r.campo_id] = r.valor;
        });

        const filas = Object.values(filasMap);

        // Crear PDF
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        res.setHeader('Content-disposition', `inline; filename="informe_${informe.id}.pdf"`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        doc.fontSize(18).text(informe.informe, { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).text(`Fecha: ${new Date(informe.fecha).toLocaleDateString('es-ES')}`);
        doc.text(`Grupo: ${informe.grupo_id || 'Ninguno'}`);
        doc.text(`Instrumento: ${informe.instrumento_id || 'Ninguno'}`);
        doc.moveDown();

        // Tabla
        const headers = campos.map(c => c.nombre);
        const includeAlumno = filas.some(f => f.alumno !== '-');

        if (includeAlumno) headers.unshift('Alumno');

        // Cabecera
        doc.font('Helvetica-Bold').text(headers.join(' | '));
        doc.moveDown(0.5);
        doc.font('Helvetica');

        // Filas
        filas.forEach(f => {
          const valores = campos.map(c => {
            let v = f.valores[c.id];
            if (c.tipo === 'booleano') v = v === '1' ? 'Sí' : 'No';
            return v || '';
          });
          if (includeAlumno) valores.unshift(f.alumno);
          doc.text(valores.join(' | '));
        });

        doc.end();
      });
    });
  });
});

module.exports = router;



