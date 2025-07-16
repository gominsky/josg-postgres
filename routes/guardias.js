function filtrarAlumnosOcupados(alumnos, fecha_inicio, callback) {
  const sql = `
    SELECT alumno_id_1, alumno_id_2
    FROM guardias
    WHERE fecha_inicio = ?
  `;

  db.all(sql, [fecha_inicio], (err, filas) => {
    if (err) return callback(err);

    const ocupados = new Set();
    filas.forEach(row => {
      if (row.alumno_id_1) ocupados.add(row.alumno_id_1);
      if (row.alumno_id_2) ocupados.add(row.alumno_id_2);
    });

    const libres = alumnos.filter(a => !ocupados.has(a.id));
    callback(null, libres);
  });
}
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const getCursoActual = () => {
  const hoy = new Date();
  const año = hoy.getFullYear();
  return hoy.getMonth() >= 7 ? `${año}/${año + 1}` : `${año - 1}/${año}`;
};
const PDFDocument = require('pdfkit');
const fs = require('fs');
const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

// routes/guardias.js
router.get('/', (req, res) => {
  const { desde, hasta, busqueda, grupo } = req.query;      // ← añadimos grupo

  // 1) cargar lista de grupos para el SELECT
  db.all('SELECT id, nombre FROM grupos ORDER BY nombre', [], (errGrp, grupos) => {
    if (errGrp) {
      console.error('❌ Error al cargar grupos:', errGrp.message);
      return res.status(500).send('Error al cargar grupos');
    }

    const condiciones = [];
    const params = [];

    let sql = `
      SELECT 
        e.id AS evento_id,
        e.titulo AS evento,
        e.fecha_inicio,
        gr.nombre AS grupo,
        g.id AS guardia_id,
        g.notas,
        a1.nombre || ' ' || a1.apellidos AS guardia1,
        a2.nombre || ' ' || a2.apellidos AS guardia2
      FROM eventos e
      LEFT JOIN guardias g ON g.evento_id = e.id
      LEFT JOIN alumnos a1 ON g.alumno_id_1 = a1.id
      LEFT JOIN alumnos a2 ON g.alumno_id_2 = a2.id
      LEFT JOIN grupos gr ON e.grupo_id = gr.id
    `;

    if (desde) {
      condiciones.push("DATE(e.fecha_inicio) >= DATE(?)");
      params.push(desde);
    }
    if (hasta) {
      condiciones.push("DATE(e.fecha_inicio) <= DATE(?)");
      params.push(hasta);
    }
    if (busqueda) {
      condiciones.push(`(
        LOWER(e.titulo) LIKE ? OR
        LOWER(gr.nombre) LIKE ? OR
        LOWER(a1.nombre || ' ' || a1.apellidos) LIKE ? OR
        LOWER(a2.nombre || ' ' || a2.apellidos) LIKE ?
      )`);
      const term = `%${busqueda.toLowerCase()}%`;
      params.push(term, term, term, term);
    }

    // 2) filtro por grupo si viene en la URL
    if (grupo) {
      condiciones.push('gr.id = ?');
      params.push(grupo);
    }

    if (condiciones.length > 0) {
      sql += ' WHERE ' + condiciones.join(' AND ');
    }
    sql += ' ORDER BY e.fecha_inicio ASC';

    // 3) ejecutar la consulta de guardias
    db.all(sql, params, (err, guardias) => {
      if (err) {
        console.error('❌ Error al cargar guardias:', err.message);
        return res.status(500).send('Error al cargar guardias');
      }

      // 4) renderizar, incluyendo siempre `grupos` y `grupo`
      res.render('guardias_lista', {
        title:   'Listado de Guardias',
        guardias,
        grupos,           // ← lista completa para el SELECT
        grupo,            // ← opción actualmente seleccionada
        mensaje: req.session.mensaje,
        desde,
        hasta,
        busqueda
      });
      delete req.session.mensaje;
    });
  });
});

router.get('/evento/:eventoId', (req, res) => {
  const { eventoId } = req.params;
  res.send(`🔍 Ver guardias para evento ID: ${eventoId}`);
});
  
router.post('/generar', (req, res) => {
  const { evento_id, desde, hasta } = req.body;
  const curso = getCursoActual();

  const sqlFecha = `SELECT fecha_inicio, grupo_id FROM eventos WHERE id = ?`;
  db.get(sqlFecha, [evento_id], (err0, evento) => {
    if (err0 || !evento) return res.status(500).send('Evento no encontrado');

    const { fecha_inicio, grupo_id } = evento;

    const sqlAlumnos = `
      SELECT a.*, ag.grupo_id
      FROM alumnos a
      JOIN alumno_grupo ag ON a.id = ag.alumno_id
      WHERE ag.grupo_id = ? AND a.activo = 1
    `;

    db.all(sqlAlumnos, [grupo_id], (err1, alumnos) => {
      if (err1 || !alumnos.length) return res.status(500).send('Error al obtener alumnos');

      const sqlGuardiasDia = `
        SELECT alumno_id_1, alumno_id_2
        FROM guardias
        WHERE fecha = ?
      `;

      db.all(sqlGuardiasDia, [fecha_inicio], (err2, guardiasDia) => {
        if (err2) return res.status(500).send('Error al consultar guardias del día');

        const ocupados = new Set();
        guardiasDia.forEach(g => {
          if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
          if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
        });

        const disponibles = alumnos.filter(a => !ocupados.has(a.id));

        if (!disponibles.length) {
          req.session.error = 'Sin alumnos disponibles para esta fecha';
          return res.redirect('/guardias');
        }

        const novatos = disponibles.filter(a => a.curso_ingreso === curso);
        const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);

        let parejas = [];

        for (let v of veteranos) {
          for (let otro of disponibles) {
            if (v.id !== otro.id && (otro.curso_ingreso !== curso || v.curso_ingreso !== curso)) {
              parejas.push([v, otro]);
            }
          }
        }

        // Aleatoriza antes de ordenar, para que parejas con igual carga no salgan siempre igual
    parejas = parejas.sort(() => Math.random() - 0.5); // Barajamos
    parejas.sort((a, b) => {
    const totalA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
    const totalB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
  return totalA - totalB;
  });
        if (!parejas.length) {
          req.session.error = 'No hay parejas válidas para esta guardia';
          return res.redirect('/guardias');
        }

        const [a1, a2] = parejas[0];

        db.run(`
          INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
          VALUES (?, ?, ?, ?, ?, NULL)
        `, [evento_id, fecha_inicio, a1.id, a2.id, curso], function (err3) {
          if (err3) {
            console.error('❌ Error al guardar guardia:', err3.message);
            return res.status(500).send('Error al guardar guardia');
          }

          // 🔁 Aumentar contadores
          db.run(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = ?`, [a1.id]);
          db.run(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = ?`, [a2.id]);

          req.session.mensaje = 'Guardia sugerida correctamente ✅';
          const query = `?desde=${encodeURIComponent(desde || '')}&hasta=${encodeURIComponent(hasta || '')}`;
          res.redirect('/guardias' + query);
        });
      });
    });
  });
});

router.get('/editar/:id', (req, res) => {
  const { id } = req.params;
  const { desde, hasta } = req.query;
  const sql = `
    SELECT g.*, e.titulo AS evento
    FROM guardias g
    JOIN eventos e ON g.evento_id = e.id
    WHERE g.id = ?
  `;

  db.get(sql, [id], (err, guardia) => {
    if (err || !guardia) return res.status(404).send('Guardia no encontrada');

    const grupoSql = `
      SELECT ag.alumno_id, a.nombre, a.apellidos
      FROM alumno_grupo ag
      JOIN alumnos a ON ag.alumno_id = a.id
      WHERE ag.grupo_id = (SELECT grupo_id FROM eventos WHERE id = ?)
      AND a.activo = 1
      ORDER BY a.apellidos, a.nombre
    `;

    db.all(grupoSql, [guardia.evento_id], (err2, alumnos) => {
      if (err2) return res.status(500).send('Error al cargar alumnos');
      res.render('guardias_editar', {
      guardia,
      alumnos,
      desde,
      hasta
      });
    });
  });
});

router.post('/guardar', (req, res) => {
  const { id, alumno_id_1, alumno_id_2, notas, desde, hasta } = req.body;

  const sql = `
    UPDATE guardias
    SET alumno_id_1 = ?, alumno_id_2 = ?, notas = ?
    WHERE id = ?
  `;

  db.run(sql, [alumno_id_1, alumno_id_2, notas || '', id], function (err) {
    if (err) {
      console.error('❌ Error al guardar guardia:', err.message);
      return res.status(500).send('Error al guardar guardia');
    }
    const query = `?desde=${encodeURIComponent(desde || '')}&hasta=${encodeURIComponent(hasta || '')}&grupo=${encodeURIComponent(grupo || '')}`;
    res.redirect('/guardias' + query);
  });
});

router.post('/eliminar/:id', (req, res) => {
  const guardiaId = req.params.id;
  const { desde, hasta } = req.query;

  const obtenerAlumnos = `
    SELECT alumno_id_1, alumno_id_2
    FROM guardias
    WHERE id = ?
  `;

  db.get(obtenerAlumnos, [guardiaId], (err, fila) => {
    if (err || !fila) {
      console.error('❌ Error obteniendo alumnos de la guardia:', err?.message);
      req.session.error = 'No se pudo encontrar la guardia';
      return res.redirect('/guardias');
    }

    const { alumno_id_1, alumno_id_2 } = fila;

    db.run(`DELETE FROM guardias WHERE id = ?`, [guardiaId], function (err2) {
      if (err2) {
        console.error('❌ Error eliminando guardia:', err2.message);
        req.session.error = 'Error al eliminar la guardia';
        return res.redirect('/guardias');
      }

      if (alumno_id_1) {
        db.run(`UPDATE alumnos SET guardias_actual = guardias_actual - 1 WHERE id = ? AND guardias_actual > 0`, [alumno_id_1]);
      }
      if (alumno_id_2) {
        db.run(`UPDATE alumnos SET guardias_actual = guardias_actual - 1 WHERE id = ? AND guardias_actual > 0`, [alumno_id_2]);
      }

      req.session.mensaje = 'Guardia eliminada correctamente ✅';

      const queryParams = [];
      if (desde) queryParams.push(`desde=${encodeURIComponent(desde)}`);
      if (hasta) queryParams.push(`hasta=${encodeURIComponent(hasta)}`);
      const query = queryParams.length ? `?${queryParams.join('&')}` : '';

      res.redirect('/guardias' + query);
    });
  });
});

router.post('/generar-multiples', (req, res) => {
  const { desde, hasta, grupo } = req.body;   // <-- incluimos grupo
  const curso = getCursoActual();

  // 1) Construimos la consulta de eventos pendientes
  let sqlEventos = `
    SELECT e.id AS evento_id, e.fecha_inicio, e.grupo_id
    FROM eventos e
    LEFT JOIN guardias g ON g.evento_id = e.id
    WHERE e.fecha_inicio BETWEEN ? AND ? AND g.id IS NULL
  `;
  const paramsEventos = [desde, hasta];

  // 2) Si se ha seleccionado un grupo, añadimos filtro
  if (grupo) {
    sqlEventos += ' AND e.grupo_id = ?';
    paramsEventos.push(grupo);
  }

  sqlEventos += ' ORDER BY e.fecha_inicio ASC';

  // 3) Ejecutamos la consulta
  db.all(sqlEventos, paramsEventos, (err, eventos) => {
    if (err) {
      console.error('❌ Error cargando eventos:', err.message);
      return res.status(500).send('Error al buscar eventos sin guardia');
    }

    if (!eventos.length) {
      req.session.mensaje = 'No hay eventos sin guardia en ese rango.';
      return res.redirect('/guardias');
    }

    const ocupadosPorFecha = {};

    const procesarSiguiente = (i) => {
      if (i >= eventos.length) {
        req.session.mensaje = 'Guardias generadas correctamente ✅';
        return res.redirect('/guardias');
      }

      const evento = eventos[i];

      db.serialize(() => {
        const sqlAlumnos = `
          SELECT a.*, ag.grupo_id
          FROM alumnos a
          JOIN alumno_grupo ag ON a.id = ag.alumno_id
          WHERE ag.grupo_id = ? AND a.activo = 1
        `;
        db.all(sqlAlumnos, [evento.grupo_id], (err2, alumnos) => {
          if (err2 || !alumnos.length) {
            return procesarSiguiente(i + 1);
          }

          const fechaStr = evento.fecha_inicio;
          const sqlGuardiasDia = `
            SELECT alumno_id_1, alumno_id_2
            FROM guardias
            WHERE DATE(fecha) = DATE(?)
          `;
          db.all(sqlGuardiasDia, [fechaStr], (err3, guardiasDelDia) => {
            if (err3) {
              console.error('❌ Error guardias del día:', err3.message);
              return procesarSiguiente(i + 1);
            }

            if (!ocupadosPorFecha[fechaStr]) {
              const ocupados = new Set();
              guardiasDelDia.forEach(g => {
                if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
                if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
              });
              ocupadosPorFecha[fechaStr] = ocupados;
            }

            const ocupados = ocupadosPorFecha[fechaStr];
            const disponibles = alumnos.filter(a => !ocupados.has(a.id));
            const novatos = disponibles.filter(a => a.curso_ingreso === curso);
            const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);

            let parejas = [];
            for (let v of veteranos) {
              for (let otro of disponibles) {
                if (v.id !== otro.id &&
                    (otro.curso_ingreso !== curso || v.curso_ingreso !== curso)) {
                  parejas.push([v, otro]);
                }
              }
            }

            // Aleatorizamos y luego ordenamos por carga de guardias
            parejas = parejas.sort(() => Math.random() - 0.5)
                              .sort((a, b) => {
                const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
                const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
                return cargaA - cargaB;
              });

            if (parejas.length > 0) {
              const [a1, a2] = parejas[0];
              db.run(`
                INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
                VALUES (?, ?, ?, ?, ?, NULL)
              `, [evento.evento_id, fechaStr, a1.id, a2.id, curso], function (err4) {
                if (err4) {
                  console.error(`❌ Error insertando guardia para evento ${evento.evento_id}:`, err4.message);
                  return procesarSiguiente(i + 1);
                }
                ocupadosPorFecha[fechaStr].add(a1.id);
                ocupadosPorFecha[fechaStr].add(a2.id);

                // Actualizamos el contador de guardias de cada alumno
                db.run(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = ?`, [a1.id]);
                db.run(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = ?`, [a2.id], () => {
                  procesarSiguiente(i + 1);
                });
              });
            } else {
              // Sin parejas disponibles, pasamos al siguiente evento
              procesarSiguiente(i + 1);
            }
          });
        });
      });
    };

    procesarSiguiente(0);
  });
});

router.get('/informe', (req, res) => {
  res.render('guardias_informe_form', { hero: false });
});

router.post('/informe', (req, res) => {
  const { desde, hasta } = req.body;

  const sql = `
    SELECT 
      e.fecha_inicio AS fecha,
      e.titulo AS evento,
      gr.nombre AS grupo,
      a1.nombre || ' ' || a1.apellidos AS guardia1,
      a2.nombre || ' ' || a2.apellidos AS guardia2
    FROM eventos e
    JOIN guardias g ON g.evento_id = e.id
    LEFT JOIN alumnos a1 ON g.alumno_id_1 = a1.id
    LEFT JOIN alumnos a2 ON g.alumno_id_2 = a2.id
    LEFT JOIN grupos gr ON e.grupo_id = gr.id
    WHERE DATE(e.fecha_inicio) BETWEEN ? AND ?
    ORDER BY e.fecha_inicio ASC
  `;

  db.all(sql, [desde, hasta], (err, eventos) => {
    if (err) return res.status(500).send('Error al generar informe');

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-disposition', 'attachment; filename="calendario_guardias.pdf"');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    // Agrupar eventos por mes
    const eventosPorMes = {};
    eventos.forEach(ev => {
      const fecha = dayjs(ev.fecha);
      const key = fecha.format('YYYY-MM');
      if (!eventosPorMes[key]) eventosPorMes[key] = [];
      eventosPorMes[key].push({
        dia: fecha.date(),
        evento: ev.evento,
        grupo: ev.grupo,
        guardias: [ev.guardia1, ev.guardia2].filter(Boolean).join(' y ')
      });
    });

    const meses = Object.keys(eventosPorMes);

    for (let i = 0; i < meses.length; i++) {
      const mesKey = meses[i];
      const [year, month] = mesKey.split('-').map(Number);
      const primerDia = dayjs(`${year}-${month}-01`);
      const ultimoDia = primerDia.endOf('month');

      if (i > 0) doc.addPage(); // solo añadimos página a partir del segundo mes

      // CABECERA
      if (fs.existsSync('./public/logo.png')) {
        doc.image('./public/logo.png', 30, 30, { width: 40 });
      }

      const grupoTexto = eventosPorMes[mesKey][0].grupo || '';
      doc.fontSize(14).text(grupoTexto.toUpperCase(), 100, 30, { align: 'center' });
      doc.fontSize(20).text(primerDia.format('MMMM YYYY').toUpperCase(), { align: 'center' });

      // Subtítulo con fechas del informe
      doc.fontSize(10).fillColor('gray')
         .text(`Guardias entre ${dayjs(desde).format('DD/MM/YYYY')} y ${dayjs(hasta).format('DD/MM/YYYY')}`, { align: 'center' })
         .moveDown();

      // CALENDARIO
      const margenX = 40;
      const margenY = 110;
      const ancho = 520;
      const alto = 350;
      const diasSemana = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
      const cellWidth = ancho / 7;
      const cellHeight = alto / 6;

      diasSemana.forEach((d, i) => {
        doc.fontSize(10).fillColor('black').text(d, margenX + i * cellWidth + 5, margenY - 15);
      });

      let fila = 0;
      let columna = primerDia.day();
      for (let dia = 1; dia <= ultimoDia.date(); dia++) {
        const x = margenX + columna * cellWidth;
        const y = margenY + fila * cellHeight;

        doc.rect(x, y, cellWidth, cellHeight).stroke();
        doc.fontSize(8).fillColor('black').text(dia.toString(), x + 2, y + 2);

        const eventoDia = eventosPorMes[mesKey].find(ev => ev.dia === dia);
        if (eventoDia) {
          const texto = `${eventoDia.evento}\n${eventoDia.guardias}`;
          doc.fontSize(6).fillColor('black').text(texto, x + 2, y + 12, {
            width: cellWidth - 4
          });
        }

        columna++;
        if (columna > 6) {
          columna = 0;
          fila++;
        }
      }

      // PIE DE PÁGINA
      doc.fontSize(8).fillColor('gray').text(`Generado el ${dayjs().format('DD/MM/YYYY HH:mm')}`, 0, 800, { align: 'center' });
    }

    doc.end();
  });
});

module.exports = router;

