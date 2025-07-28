// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PDFDocument = require('pdfkit');
const ejs = require('ejs');
const path = require('path');
const util = require('util'); 
const fs   = require('fs');
const { isAuthenticated } = require('../middleware/auth');
// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/lista');
});
// Formulario inicial
router.get('/ficha', (req, res) => {
  db.all('SELECT * FROM grupos ORDER BY nombre', (e1, grupos) => {
    if (e1) return res.status(500).send('Error cargando grupos');
    db.all('SELECT * FROM instrumentos ORDER BY nombre', (e2, instrumentos) => {
      if (e2) return res.status(500).send('Error cargando instrumentos');
      res.render('informe_form', {
        grupos,
        instrumentos,
        alumnos: [],       // sin alumnos al principio
        campos: [],
        nombreInforme: '',
        grupoSeleccionado: 'todos',
        instrumentoSeleccionado: 'todos',
        fechaHoy:    new Date().toISOString().split('T')[0],
        // **Estos dos son claves:**
        showGroup: false,
        showInstrument: false
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
              fecha_fin: informe.fecha,
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
   // 🆕 Si es un nuevo informe
db.get(
  `SELECT id 
     FROM informes 
    WHERE informe        = ?
      AND (grupo_id      IS ? OR grupo_id      = ?)
      AND (instrumento_id IS ? OR instrumento_id = ?)
      AND fecha          = ?`,
  [
    nombre_informe,
    grupoIdFinal, grupoIdFinal,
    instrumentoIdFinal, instrumentoIdFinal,
    fecha
  ],
  (err, row) => {
    if (err) return res.status(500).send('Error comprobando duplicados');
    if (row) {
      // Ya existía: reutilizamos su id
      guardarResultadosYCampos(row.id);
    } else {
      // No existía: creamos uno nuevo
      db.run(
        `INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
         VALUES (?, ?, ?, ?)`,
        [nombre_informe, grupoIdFinal, instrumentoIdFinal, fecha],
        function (err2) {
          if (err2) return res.status(500).send('Error al guardar informe nuevo');
          guardarResultadosYCampos(this.lastID);
        }
      );
    }
  }
);
}
});
// routes/informes.js
router.get('/detalle/:id', (req, res) => {
  const id = req.params.id;
  db.get(`
    SELECT i.*, g.nombre AS informeGrupo, inst.nombre AS informeInstrumento
    FROM informes i
    LEFT JOIN grupos g ON i.grupo_id = g.id
    LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
    WHERE i.id = ?
  `, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    const showGroup      = informe.grupo_id      != null;
    const showInstrument = informe.instrumento_id != null;

    db.all(`SELECT * FROM informe_campos WHERE informe_id = ? ORDER BY id`, [id], (errC, campos) => {
      if (errC) return res.status(500).send('Error al obtener campos');

      db.all(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = ? AND (a.id IS NULL OR a.activo = 1)
      `, [id], (errR, resultados) => {
        if (errR) return res.status(500).send('Error al obtener resultados');

        // 1) Agrupar por fila/alumno
        const filasMap = {};
        resultados.forEach(r => {
          const key = r.alumno_id !== null ? `a_${r.alumno_id}` : `f_${r.fila}`;
          if (!filasMap[key]) {
            filasMap[key] = {
              alumno_id: r.alumno_id,
              fila:       r.fila,
              nombre:     r.nombre || '',
              apellidos:  r.apellidos || '',
              valores:    {}
            };
          }
          filasMap[key].valores[r.campo_id] = r.valor;
        });
        let filas = Object.values(filasMap);

        // 2) Enriquecer cada fila con los grupos e instrumentos del alumno
        const promesas = filas.map(f => {
          if (!f.alumno_id) return Promise.resolve(f);
          return Promise.all([
            new Promise((ok, ko) => {
              db.all(
                `SELECT g.nombre
                   FROM grupos g
                   JOIN alumno_grupo ag ON ag.grupo_id = g.id
                   WHERE ag.alumno_id = ?
                   ORDER BY g.nombre`,
                [f.alumno_id],
                (e, rows) => e ? ko(e) : ok(rows.map(r=>r.nombre).join(', '))
              );
            }),
            new Promise((ok, ko) => {
              db.all(
                `SELECT i.nombre
                   FROM instrumentos i
                   JOIN alumno_instrumento ai ON ai.instrumento_id = i.id
                   WHERE ai.alumno_id = ?
                   ORDER BY i.nombre`,
                [f.alumno_id],
                (e, rows) => e ? ko(e) : ok(rows.map(r=>r.nombre).join(', '))
              );
            })
          ]).then(([grupos, instrumentos]) => ({
            ...f,
            grupos,
            instrumentos
          }));
        });

        Promise.all(promesas)
          .then(filasEnriquecidas => {
            // 3) Ordenar
            filasEnriquecidas.sort((a, b) => {
              if (a.alumno_id && b.alumno_id) {
                return a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre);
              }
              if (!a.alumno_id && !b.alumno_id) {
                return (a.fila || 0) - (b.fila || 0);
              }
              return a.alumno_id ? -1 : 1;
            });

            const tieneAlumnos = filasEnriquecidas.some(f => f.alumno_id !== null);

            // 4) Renderizar enviando showGroup/showInstrument
            res.render('informes_detalle', {
              informe,
              campos,
              filas: filasEnriquecidas,
              tieneAlumnos,
              showGroup,
              showInstrument
            });
          })
          .catch(e => {
            console.error('Error enriqueciendo filas:', e);
            res.status(500).send('Error procesando informe');
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
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    fecha_fin,
    mostrar_grupo,
    mostrar_instrumento
  } = req.body;

  const showGroup      = !!mostrar_grupo;
  const showInstrument = !!mostrar_instrumento;

  // 1) Construir SQL base para alumnos activos
  let sql    = `
    SELECT DISTINCT a.id, a.nombre, a.apellidos
      FROM alumnos a
 LEFT JOIN alumno_grupo ag       ON a.id = ag.alumno_id
 LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
     WHERE a.activo = 1
  `;
  const params = [];

  // Filtro por grupo
  if (grupo_id !== 'todos') {
    if (grupo_id === 'ninguno') {
      sql += ' AND ag.grupo_id IS NULL';
    } else {
      sql   += ' AND ag.grupo_id = ?';
      params.push(grupo_id);
    }
  }

  // Filtro por instrumento
  if (instrumento_id !== 'todos') {
    if (instrumento_id === 'ninguno') {
      sql += ' AND ai.instrumento_id IS NULL';
    } else {
      sql   += ' AND ai.instrumento_id = ?';
      params.push(instrumento_id);
    }
  }

  sql += ' ORDER BY a.apellidos, a.nombre';
  // 2) Obtener los alumnos filtrados
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).send('Error al cargar alumnos');

    // 3) Enriquecer con nombres de grupo e instrumento
    const promesas = rows.map(a =>
      new Promise((ok, ko) => {
        db.all(
          `SELECT g.nombre
             FROM grupos g
             JOIN alumno_grupo ag ON g.id = ag.grupo_id
            WHERE ag.alumno_id = ?`,
          [a.id],
          (e1, grpRows) => {
            if (e1) return ko(e1);
            db.all(
              `SELECT i.nombre
                 FROM instrumentos i
                 JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
                WHERE ai.alumno_id = ?`,
              [a.id],
              (e2, instRows) => {
                if (e2) return ko(e2);
                ok({
                  id: a.id,
                  nombre: a.nombre,
                  apellidos: a.apellidos,
                  grupos: grpRows.map(r => r.nombre).join(', '),
                  instrumentos: instRows.map(r => r.nombre).join(', ')
                });
              }
            );
          }
        );
      })
    );

    Promise.all(promesas)
      .then(alumnos => {
        // 4) Volver a cargar listas para selects de grupo e instrumento
        db.all('SELECT * FROM grupos ORDER BY nombre', (errG, grupos) => {
          if (errG) grupos = [];
          db.all('SELECT * FROM instrumentos ORDER BY nombre', (errI, instrumentos) => {
            if (errI) instrumentos = [];
            // 5) Renderizar la vista
            res.render('informe_form', {
              grupos,
              instrumentos,
              alumnos,
              campos: [],
              nombreInforme: nombre_informe,
              grupoSeleccionado: grupo_id,
              instrumentoSeleccionado: instrumento_id,
              profesorSeleccionado: null,
              fechaHoy: fecha,
              fecha_fin,
              showGroup,
              showInstrument
            });
          });
        });
      })
      .catch(e => {
        console.error(e);
        res.status(500).send('Error al enriquecer datos de alumnos');
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
router.get('/certificados', (req, res) => {
  // Carga listas para filtros (si las necesita tu vista)
  db.all('SELECT id, nombre FROM grupos ORDER BY nombre', (errGrp, grupos) => {
    if (errGrp) return res.status(500).send('Error cargando grupos');
    db.all('SELECT id, nombre FROM instrumentos ORDER BY nombre', (errInst, instrumentos) => {
      if (errInst) return res.status(500).send('Error cargando instrumentos');
      // Renderiza la nueva vista
      res.render('informes_y_certificados', {
        title: 'Informes y Certificados',
        hero: false,
        grupos,
        instrumentos,
        // cualquier otra variable que tu vista requiera
      });
    });
  });
});
// GET /informes/horas porcentaje
router.get('/horas', isAuthenticated, (req, res) => {
  // Desestructuramos los parámetros tal como vienen del formulario
  const { fecha, fecha_fin, grupo, instrumento } = req.query;

  // Preparamos los filtros dinámicos
  const whereE  = [];
  const paramsE = [];

  if (fecha) {
    whereE.push("e.fecha_inicio >= ?");
    paramsE.push(fecha);
  }
  if (fecha_fin) {
    whereE.push("e.fecha_fin <= ?");
    paramsE.push(fecha_fin + " 23:59:59");
  }
  if (grupo) {
    whereE.push("e.grupo_id = ?");
    paramsE.push(grupo);
  }

  const whereClause = whereE.length ? "WHERE " + whereE.join(" AND ") : "";

  // 1) Total de horas en el periodo
  const sqlTotal = `
    SELECT 
      SUM(
        (strftime('%s', e.fecha_fin) - strftime('%s', e.fecha_inicio)) / 3600.0
      ) AS total_horas
    FROM eventos e
    ${whereClause}
  `;

  // 2) Horas por alumno (manual + qr)
  const sqlPorAlumno = `
    SELECT 
      a.id,
      a.nombre || ' ' || a.apellidos AS alumno,
      SUM(
        (strftime('%s', e.fecha_fin) - strftime('%s', e.fecha_inicio)) / 3600.0
      ) AS horas
    FROM asistencias asi
    JOIN alumnos a   ON asi.alumno_id = a.id
    JOIN eventos e   ON asi.evento_id = e.id
    ${instrumento 
      ? "JOIN alumno_instrumento ai ON ai.alumno_id = a.id AND ai.instrumento_id = ?" 
      : ""
    }
    ${whereClause ? "AND " + whereE.join(" AND ").replace(/^e\./, 'e.') : ""}
      AND asi.tipo IN ('manual','qr')
    GROUP BY a.id, a.nombre, a.apellidos
    HAVING horas > 0
  `;

  // Ejecutamos la consulta de total
  db.get(sqlTotal, paramsE, (err, tot) => {
    if (err) return res.status(500).send("Error calculando total de horas");
    const totalHoras = tot.total_horas || 0;

    // Preparamos parámetros para la consulta por alumno
    const paramsA = [...paramsE];
    if (instrumento) paramsA.push(instrumento);

    // Ejecutamos la consulta por alumno
    db.all(sqlPorAlumno, paramsA, (err2, rows) => {
      if (err2) return res.status(500).send("Error calculando horas por alumno");

      // Calcular porcentaje
      const resultados = rows.map(r => ({
        id: r.id,
        alumno:     r.alumno,
        horas:      Number(r.horas.toFixed(2)),
        porcentaje: totalHoras > 0 
          ? Number(((r.horas / totalHoras) * 100).toFixed(1)) 
          : 0
      }));

      // Renderizamos pasando fecha y fecha_fin para que sigan disponibles en la vista
      res.render('informes_horas', {
        fecha,
        fecha_fin,
        grupo,
        instrumento,
        totalHoras,
        resultados
      });
    });
  });
});
// POST: Guardar informe de porcentaje de horas
router.post('/horas/guardar', isAuthenticated, (req, res) => {
  const { fecha, fecha_fin, grupo, instrumento, resultados } = req.body;
  const parsed = JSON.parse(resultados || '[]');
  const opts = { day: '2-digit', month: 'long', year: 'numeric' };
  const fi = new Date(fecha).toLocaleDateString('es-ES', opts);
  const ff = fecha_fin
           ? new Date(fecha_fin).toLocaleDateString('es-ES', opts)
           : null;

  // 2) Construir el título dinámico
  const nombreInforme = `Porcentaje de horas de asistencia (${fi}`
        + (ff ? ` – ${ff}` : '')
        + `)`;
  db.run(
    `INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
     VALUES (?, ?, ?, ?)`,
    [
      nombreInforme,
      grupo === 'todos' ? null : grupo,
      instrumento === 'todos' ? null : instrumento,
      fecha_fin
    ],
    function (err) {
      if (err) return res.status(500).send('Error al crear informe');
      const informeId = this.lastID;

      // 1) Creamos los tres campos dinámicos: Alumno, Horas, Porcentaje
      const sqlCampo = `
        INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
        VALUES (?, ?, ?, 0)
      `;
      // Campo 1: Alumno (guardaremos el ID)
      db.run(sqlCampo, [informeId, 'Alumno', 'numero']);
      // Campo 2: Horas
      db.run(sqlCampo, [informeId, 'Horas', 'numero']);
      // Campo 3: Porcentaje
      db.run(sqlCampo, [informeId, 'Porcentaje', 'numero'], err2 => {
        if (err2) return res.status(500).send('Error al crear campos');

        // 2) Leemos los IDs de los campos en orden de inserción
        db.all(
    `SELECT id, nombre FROM informe_campos
     WHERE informe_id = ? ORDER BY id`,
    [informeId],
    (err3, campos) => {
      // campos[0]=Alumno, campos[1]=Horas, campos[2]=Porcentaje
      const sqlRes = `
        INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
        VALUES (?, ?, ?, ?)
      `;
      const insertRes = db.prepare(sqlRes);

      parsed.forEach(r => {
        // 1) Guardamos el alumno_id
        insertRes.run(informeId, r.alumno_id, campos[0].id, String(r.alumno_id));
        // 2) Guardamos las horas
        insertRes.run(informeId, r.alumno_id, campos[1].id, String(r.horas));
        // 3) Guardamos el porcentaje
        insertRes.run(informeId, r.alumno_id, campos[2].id, String(r.porcentaje));
      });

      insertRes.finalize(() => {
        res.redirect(`/informes/detalle/${informeId}`);
      });
    }
  );
});
    }
  );
});
router.get('/pdf/:id', (req, res) => {
  const id = req.params.id;

  // 1) Carga informe y metadatos
  db.get(`
    SELECT i.*, 
           g.nombre AS informeGrupo, 
           inst.nombre AS informeInstrumento
    FROM informes i
    LEFT JOIN grupos g ON i.grupo_id = g.id
    LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
    WHERE i.id = ?
  `, [id], (err, informe) => {
    if (err || !informe) return res.status(404).send('Informe no encontrado');

    const showGroup      = informe.grupo_id      != null;
    const showInstrument = informe.instrumento_id != null;

    // 2) Campos
    db.all(`SELECT * FROM informe_campos WHERE informe_id = ? ORDER BY id`, [id], (errC, campos) => {
      if (errC) return res.status(500).send('Error al obtener campos');

      // 3) Resultados crudos
      db.all(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = ?
          AND (a.id IS NULL OR a.activo = 1)
      `, [id], (errR, resultados) => {
        if (errR) return res.status(500).send('Error al obtener resultados');

        // ───── Agrupar ─────
        const filasMap = {};
        resultados.forEach(r => {
          const key = r.alumno_id != null ? `a_${r.alumno_id}` : `f_${r.fila}`;
          if (!filasMap[key]) {
            filasMap[key] = {
              alumno_id: r.alumno_id,
              fila:       r.fila,
              nombre:     r.nombre || '',
              apellidos:  r.apellidos || '',
              valores:    {}
            };
          }
          filasMap[key].valores[r.campo_id] = r.valor;
        });
        let filas = Object.values(filasMap);

        // ───── Enriquecer ─────
        const promesas = filas.map(f => {
          if (!f.alumno_id) return Promise.resolve(f);
          const pG = new Promise((ok, ko) => {
            db.all(
              `SELECT g.nombre
                 FROM grupos g
                 JOIN alumno_grupo ag ON ag.grupo_id = g.id
                WHERE ag.alumno_id = ? ORDER BY g.nombre`,
              [f.alumno_id],
              (e, rows) => e ? ko(e) : ok(rows.map(r=>r.nombre).join(', '))
            );
          });
          const pI = new Promise((ok, ko) => {
            db.all(
              `SELECT i.nombre
                 FROM instrumentos i
                 JOIN alumno_instrumento ai ON ai.instrumento_id = i.id
                WHERE ai.alumno_id = ? ORDER BY i.nombre`,
              [f.alumno_id],
              (e, rows) => e ? ko(e) : ok(rows.map(r=>r.nombre).join(', '))
            );
          });
          return Promise.all([pG, pI]).then(
            ([grupos, instrumentos]) => ({ ...f, grupos, instrumentos })
          );
        });

        Promise.all(promesas)
          .then(filasFinal => {
            // ───── Ordenar ─────
            filasFinal.sort((a, b) => {
              if (a.alumno_id && b.alumno_id) {
                return a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre);
              } else if (!a.alumno_id && !b.alumno_id) {
                return (a.fila||0) - (b.fila||0);
              }
              return a.alumno_id ? -1 : 1;
            });

            // ───── Render header/footer ─────
            const headerTpl = path.join(__dirname, '../views/pdf-header.ejs');
            const footerTpl = path.join(__dirname, '../views/pdf-footer.ejs');

            ejs.renderFile(headerTpl, {}, {}, (eH, headerHtml) => {
              if (eH) console.error(eH);
              ejs.renderFile(footerTpl, {}, {}, (eF, footerHtml) => {
                if (eF) console.error(eF);

                // ───── Generar PDF ─────
                res.setHeader('Content-Disposition', `attachment; filename="informe_${id}.pdf"`);
                res.setHeader('Content-Type', 'application/pdf');
                const doc = new PDFDocument({ margin: 40, size: 'A4' });
                doc.pipe(res);

                // Header
                doc.fontSize(10).text(headerHtml, { align: 'left' }).moveDown();

                // Título y subt
                doc.fontSize(16).text(informe.informe, { align: 'center' }).moveDown(0.5);
                doc.fontSize(10).text(`Fecha: ${new Date(informe.fecha).toLocaleDateString('es-ES')}`);
                if (showGroup)      doc.text(`Grupo: ${informe.informeGrupo}`);
                if (showInstrument) doc.text(`Instrumento: ${informe.informeInstrumento}`);
                doc.moveDown();

                // Tabla
                const startX = doc.x;
                const colWidths = [150,100,100].concat(campos.map(()=>80));
                const headers   = ['Alumno','Grupo','Instrumento'].concat(campos.map(c=>c.nombre));
                headers.forEach((h,i) => {
                  doc.font('Helvetica-Bold').fontSize(9)
                     .text(h, startX + colWidths.slice(0,i).reduce((a,b)=>a+b,0),
                           doc.y, { width: colWidths[i], align: 'center' });
                });
                doc.moveDown(0.5);

                filasFinal.forEach(f => {
                  const alumno = f.alumno_id ? `${f.apellidos}, ${f.nombre}` : '—';
                  const grp    = f.grupos      || '—';
                  const inst   = f.instrumentos|| '—';
                  const vals   = campos.map(c=>f.valores[c.id]||'');
                  [alumno,grp,inst].concat(vals).forEach((txt,i) => {
                    doc.font('Helvetica').fontSize(8)
                       .text(txt, startX + colWidths.slice(0,i).reduce((a,b)=>a+b,0),
                             doc.y, { width: colWidths[i], align: 'center' });
                  });
                  doc.moveDown(0.4);
                });
                doc.moveDown();

                // Pie
                doc.fontSize(8).fillColor('gray')
                   .text(`Generado ${new Date().toLocaleDateString('es-ES')} a las ${new Date().toLocaleTimeString('es-ES')}`, { align: 'right' })
                   .moveDown();

                doc.fontSize(9).fillColor('black').text(footerHtml, { align: 'center' });

                doc.end();
              }); // fin ejs.renderFile footer
            });   // fin ejs.renderFile header
          })     // fin Promise.all filas
          .catch(e => {
            console.error(e);
            res.status(500).send('Error procesando informe');
          });

      }); // fin db.all resultados
    });   // fin db.all campos
  });     // fin db.get informe
});       // fin router.get

module.exports = router;