async function filtrarAlumnosOcupados(alumnos, fecha_inicio, callback) {
  try {
    const sql = `
      SELECT alumno_id_1, alumno_id_2
      FROM guardias
      WHERE fecha_inicio = $1
    `;
    const result = await db.query(sql, [fecha_inicio]);

    const ocupados = new Set();
    result.rows.forEach(row => {
      if (row.alumno_id_1) ocupados.add(row.alumno_id_1);
      if (row.alumno_id_2) ocupados.add(row.alumno_id_2);
    });

    const libres = alumnos.filter(al => !ocupados.has(al.id));
    callback(null, libres);
  } catch (err) {
    console.error('Error filtrando alumnos ocupados:', err.message);
    callback(err);
  }
}
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const getCursoActual = () => {
  const hoy = new Date();
  const año = hoy.getFullYear();
  return hoy.getMonth() >= 7 ? `${año}/${año + 1}` : `${año - 1}/${año}`;
};
//librerías externas
const PDFDocument = require('pdfkit');
const fs = require('fs');
const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

// routes/guardias.js
router.get('/', async (req, res) => {
  const { desde, hasta, busqueda, grupo } = req.query;

  try {
    // Obtener grupos para el filtro SELECT
    const gruposResult = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const grupos = gruposResult.rows;

    // Construir condiciones dinámicas
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
      condiciones.push(`DATE(e.fecha_inicio) >= DATE($${params.length + 1})`);
      params.push(desde);
    }
    if (hasta) {
      condiciones.push(`DATE(e.fecha_inicio) <= DATE($${params.length + 1})`);
      params.push(hasta);
    }
    if (busqueda) {
      condiciones.push(`(
        LOWER(e.titulo) LIKE $${params.length + 1} OR
        LOWER(gr.nombre) LIKE $${params.length + 2} OR
        LOWER(a1.nombre || ' ' || a1.apellidos) LIKE $${params.length + 3} OR
        LOWER(a2.nombre || ' ' || a2.apellidos) LIKE $${params.length + 4}
      )`);
      const term = `%${busqueda.toLowerCase()}%`;
      params.push(term, term, term, term);
    }
    if (grupo) {
      condiciones.push(`gr.id = $${params.length + 1}`);
      params.push(grupo);
    }

    if (condiciones.length > 0) {
      sql += ' WHERE ' + condiciones.join(' AND ');
    }

    sql += ' ORDER BY e.fecha_inicio ASC';

    const result = await db.query(sql, params);
    const guardias = result.rows;

    res.render('guardias_lista', {
      title: 'Listado de Guardias',
      guardias,
      grupos,
      grupo,
      mensaje: req.session.mensaje,
      desde,
      hasta,
      busqueda
    });

    delete req.session.mensaje;

  } catch (error) {
    console.error('❌ Error al cargar guardias:', error.message);
    res.status(500).send('Error al cargar guardias');
  }
});
router.get('/evento/:eventoId', async (req, res) => {
  const { eventoId } = req.params;

  try {
    const result = await db.query(
      'SELECT * FROM guardias WHERE evento_id = $1',
      [eventoId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ mensaje: 'No se encontraron guardias para este evento.' });
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener guardias:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
router.post('/generar', async (req, res) => {
  const { evento_id, desde, hasta } = req.body;
  const curso = getCursoActual();

  console.log('📥 POST /generar recibido');
  console.log('🆔 Evento ID:', evento_id, '| Curso actual:', curso);

  try {
    // Obtener fecha y grupo del evento
    const eventoResult = await db.query(
      `SELECT fecha_inicio, grupo_id FROM eventos WHERE id = $1`,
      [evento_id]
    );
    const evento = eventoResult.rows[0];
    if (!evento) {
      console.warn('⚠️ Evento no encontrado');
      return res.status(404).send('Evento no encontrado');
    }

    const { fecha_inicio, grupo_id } = evento;
    console.log('📅 Fecha del evento:', fecha_inicio, '| Grupo ID:', grupo_id);

    // Alumnos activos del grupo
    const alumnosResult = await db.query(`
      SELECT 
        a.id,
        a.nombre,
        a.apellidos,
        CASE 
          WHEN a.fecha_matriculacion IS NOT NULL THEN
            CASE 
              WHEN EXTRACT(MONTH FROM a.fecha_matriculacion::date) >= 6 THEN 
                EXTRACT(YEAR FROM a.fecha_matriculacion::date)::INT
              ELSE 
                (EXTRACT(YEAR FROM a.fecha_matriculacion::date) - 1)::INT
            END
          ELSE
            NULL
        END AS curso_ingreso,
        a.guardias_actual
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = TRUE
    `, [grupo_id]);
    const alumnos = alumnosResult.rows;
    console.log(`👥 ${alumnos.length} alumno(s) encontrados en el grupo`);

    // Alumnos ocupados ese día
    const ocupadosResult = await db.query(`
      SELECT alumno_id_1, alumno_id_2 FROM guardias WHERE fecha = $1
    `, [fecha_inicio]);
    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });
    console.log(`🚫 ${ocupados.size} alumno(s) ya ocupados ese día`);

    const disponibles = alumnos.filter(a => !ocupados.has(a.id));
    console.log(`✅ ${disponibles.length} alumno(s) disponibles`);

    if (!disponibles.length) {
      req.session.error = 'Sin alumnos disponibles para esta fecha';
      console.warn('❌ Ningún alumno disponible para esta fecha');
      return res.redirect('/guardias');
    }

    const novatos = disponibles.filter(a => a.curso_ingreso === curso);
    const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);
    console.log(`🧑‍🎓 Novatos: ${novatos.length} | 🎓 Veteranos: ${veteranos.length}`);

    // Generar parejas válidas: un novato + un veterano preferiblemente
    let parejas = [];
    for (let i = 0; i < disponibles.length; i++) {
      for (let j = i + 1; j < disponibles.length; j++) {
        parejas.push([disponibles[i], disponibles[j]]);
      }
    }
    console.log(`🤝 Total de parejas generadas: ${parejas.length}`);
    // Aleatorizar y ordenar por menor carga de guardias
    parejas = parejas
      .sort(() => Math.random() - 0.5)
      .sort((a, b) => {
        const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
        const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
        return cargaA - cargaB;
      });

    if (!parejas.length) {
      req.session.error = 'No hay parejas válidas para esta guardia';
      console.warn('❌ No se encontró ninguna pareja válida');
      return res.redirect('/guardias');
    }

    const [a1, a2] = parejas[0];
    console.log(`🆕 Pareja seleccionada: ${a1.nombre} ${a1.apellidos} & ${a2.nombre} ${a2.apellidos}`);

    // Insertar nueva guardia
    await db.query(`
      INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
      VALUES ($1, $2, $3, $4, $5, NULL)
    `, [evento_id, fecha_inicio, a1.id, a2.id, curso]);

    // Actualizar contadores
    await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a1.id]);
    await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a2.id]);
    console.log(`✅ Guardia registrada y contadores actualizados`);

    req.session.mensaje = 'Guardia sugerida correctamente ✅';
    const query = `?desde=${encodeURIComponent(desde || '')}&hasta=${encodeURIComponent(hasta || '')}`;
    res.redirect('/guardias' + query);

  } catch (error) {
    console.error('❌ Error al generar guardia:', error);
    res.status(500).send('Error al generar guardia');
  }
});
router.get('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { desde, hasta, grupo } = req.query;

  try {
    // Obtener datos de la guardia
    const result = await db.query(`
      SELECT g.*, e.titulo AS evento, e.grupo_id, e.fecha_inicio
      FROM guardias g
      JOIN eventos e ON g.evento_id = e.id
      WHERE g.id = $1
    `, [id]);

    const guardia = result.rows[0];
    if (!guardia) return res.status(404).send('Guardia no encontrada');

    // Obtener alumnos activos del grupo
    const alumnosResult = await db.query(`
      SELECT a.id, a.nombre, a.apellidos, a.guardias_actual
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = TRUE
    `, [guardia.grupo_id]);

    const alumnos = alumnosResult.rows;

    // Obtener alumnos ya ocupados ese día (excluyendo la guardia actual)
    const ocupadosResult = await db.query(`
      SELECT alumno_id_1, alumno_id_2
      FROM guardias
      WHERE fecha = $1 AND id <> $2
    `, [guardia.fecha, id]);

    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });

    // Filtrar disponibles
    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    // Generar parejas posibles (sin distinguir novato/veterano)
    let parejas = [];
    for (let i = 0; i < disponibles.length; i++) {
      for (let j = i + 1; j < disponibles.length; j++) {
        const a1 = disponibles[i];
        const a2 = disponibles[j];
        parejas.push([a1, a2]);
      }
    }

    // Ordenar por menor carga de guardias
    parejas = parejas
      .sort(() => Math.random() - 0.5)
      .sort((a, b) => {
        const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
        const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
        return cargaA - cargaB;
      });

    res.render('guardias_editar', {
      guardia,
      eventoTitulo: guardia.evento,
      disponibles,
      parejas,
      desde,
      hasta,
      grupo
    });

  } catch (err) {
    console.error('❌ Error al editar guardia:', err.message);
    res.status(500).send('Error al cargar datos de la guardia');
  }
});
router.post('/guardar', async (req, res) => {
  const { id, alumno_id_1, alumno_id_2, notas, desde, hasta, grupo } = req.body;

  const sql = `
    UPDATE guardias
       SET alumno_id_1 = $1,
           alumno_id_2 = $2,
           notas = $3
     WHERE id = $4
  `;

  try {
    await db.query(sql, [alumno_id_1, alumno_id_2, notas || '', id]);

    // Reconstruimos la query-string conservando grupo
    const params = [];
    if (desde) params.push(`desde=${encodeURIComponent(desde)}`);
    if (hasta) params.push(`hasta=${encodeURIComponent(hasta)}`);
    if (grupo)  params.push(`grupo=${encodeURIComponent(grupo)}`);
    const qs = params.length ? `?${params.join('&')}` : '';

    res.redirect('/guardias' + qs);
  } catch (err) {
    console.error('Error al guardar guardia:', err);
    res.status(500).send('Error al guardar guardia');
  }
});
router.post('/eliminar/:id', async (req, res) => {
  const guardiaId = req.params.id;
  const { desde, hasta, grupo } = req.query;

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1) Obtener los alumnos de la guardia
    const result = await client.query(
      'SELECT alumno_id_1, alumno_id_2 FROM guardias WHERE id = $1',
      [guardiaId]
    );

    if (result.rowCount === 0) {
      req.session.error = 'No se pudo encontrar la guardia';
      await client.query('ROLLBACK');
      return res.redirect('/guardias');
    }

    const { alumno_id_1, alumno_id_2 } = result.rows[0];

    // 2) Eliminar la guardia
    await client.query('DELETE FROM guardias WHERE id = $1', [guardiaId]);

    // 3) Decrementar los contadores de los alumnos (mínimo 0)
    if (alumno_id_1) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0)
         WHERE id = $1
      `, [alumno_id_1]);
    }

    if (alumno_id_2) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0)
         WHERE id = $1
      `, [alumno_id_2]);
    }

    await client.query('COMMIT');

    // 4) Reconstruir query-string y redirigir
    const params = [];
    if (desde) params.push(`desde=${encodeURIComponent(desde)}`);
    if (hasta) params.push(`hasta=${encodeURIComponent(hasta)}`);
    if (grupo)  params.push(`grupo=${encodeURIComponent(grupo)}`);
    const qs = params.length ? `?${params.join('&')}` : '';

    req.session.mensaje = 'Guardia eliminada correctamente ✅';
    res.redirect('/guardias' + qs);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error eliminando guardia:', err);
    req.session.error = 'Error al eliminar la guardia';
    res.redirect('/guardias');
  } finally {
    client.release();
  }
});
router.post('/generar-multiples', async (req, res) => {
  const { desde, hasta, grupo } = req.body;
  const curso = getCursoActual();

  console.log('📥 POST /generar-multiples recibido');
  console.log('Desde:', desde, 'Hasta:', hasta, 'Grupo:', grupo);

  let sqlEventos = `
    SELECT e.id AS evento_id, e.fecha_inicio, e.grupo_id
    FROM eventos e
    LEFT JOIN guardias g ON g.evento_id = e.id
    WHERE e.fecha_inicio BETWEEN $1 AND $2 AND g.id IS NULL
  `;
  const paramsEventos = [desde, hasta];

  if (grupo) {
    sqlEventos += ' AND e.grupo_id = $3';
    paramsEventos.push(grupo);
  }

  sqlEventos += ' ORDER BY e.fecha_inicio ASC';

  try {
    const eventosRes = await db.query(sqlEventos, paramsEventos);
    const eventos = eventosRes.rows;

    console.log('🔎 Eventos encontrados:', eventos.length);
    if (eventos.length === 0) {
      req.session.mensaje = 'No hay eventos sin guardia en ese rango.';
      return res.redirect('/guardias');
    }

    eventos.forEach(ev => {
      console.log(`🗓️ Evento ${ev.evento_id} – Fecha: ${ev.fecha_inicio} – Grupo: ${ev.grupo_id}`);
    });

    const ocupadosPorFecha = {};

    for (const evento of eventos) {
      if (!evento.fecha_inicio) {
        console.warn('⚠️ Evento sin fecha_inicio:', evento);
        continue;
      }

      const fecha = new Date(evento.fecha_inicio);
      const fechaStr = fecha.toISOString().split('T')[0];

      // Obtener alumnos activos del grupo
      const alumnosRes = await db.query(`
        SELECT a.id, a.nombre, a.apellidos, a.guardias_actual,
          CASE 
            WHEN EXTRACT(MONTH FROM a.fecha_matriculacion::date) < 6
              THEN EXTRACT(YEAR FROM a.fecha_matriculacion::date)::INT - 1
            ELSE EXTRACT(YEAR FROM a.fecha_matriculacion::date)::INT
          END AS curso_ingreso
        FROM alumnos a
        JOIN alumno_grupo ag ON a.id = ag.alumno_id
        WHERE ag.grupo_id = $1 AND a.activo = TRUE
      `, [evento.grupo_id]);

      const alumnos = alumnosRes.rows;
      console.log(`👥 Alumnos disponibles en grupo ${evento.grupo_id}:`, alumnos.length);
      if (!alumnos.length) continue;

      // Verificar ocupados
      const guardiasDiaRes = await db.query(`
        SELECT alumno_id_1, alumno_id_2
        FROM guardias
        WHERE DATE(fecha) = DATE($1)
      `, [fechaStr]);

      if (!ocupadosPorFecha[fechaStr]) {
        const ocupados = new Set();
        guardiasDiaRes.rows.forEach(g => {
          if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
          if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
        });
        ocupadosPorFecha[fechaStr] = ocupados;
      }

      const ocupados = ocupadosPorFecha[fechaStr];
      const disponibles = alumnos.filter(a => !ocupados.has(a.id));
      const novatos = disponibles.filter(a => a.curso_ingreso === curso);
      const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);

      console.log(`📅 ${fechaStr} → Disponibles: ${disponibles.length}, Novatos: ${novatos.length}, Veteranos: ${veteranos.length}`);

      let parejas = [];
      for (let v of veteranos) {
        for (let otro of disponibles) {
          if (v.id !== otro.id &&
              (v.curso_ingreso !== curso || otro.curso_ingreso !== curso)) {
            parejas.push([v, otro]);
          }
        }
      }

      console.log(`🤝 Parejas generadas para ${fechaStr}:`, parejas.length);

      parejas = parejas
        .sort(() => Math.random() - 0.5)
        .sort((a, b) => {
          const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
          const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
          return cargaA - cargaB;
        });

      if (parejas.length > 0) {
        const [a1, a2] = parejas[0];

        try {
          await db.query('BEGIN');

          await db.query(`
            INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
            VALUES ($1, $2, $3, $4, $5, NULL)
          `, [evento.evento_id, fechaStr, a1.id, a2.id, curso]);

          ocupados.add(a1.id);
          ocupados.add(a2.id);

          await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a1.id]);
          await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a2.id]);

          await db.query('COMMIT');

          console.log(`✅ Guardia asignada para evento ${evento.evento_id}: ${a1.nombre} y ${a2.nombre} → ${fechaStr}`);

        } catch (insertErr) {
          console.error(`❌ Error insertando guardia para evento ${evento.evento_id}:`, insertErr.message);
          await db.query('ROLLBACK');
        }
      } else {
        console.log(`🚫 No hay parejas válidas para ${fechaStr}`);
      }
    }

    req.session.mensaje = 'Guardias generadas correctamente ✅';
    res.redirect('/guardias');

  } catch (err) {
    console.error('❌ Error al generar guardias:', err.message);
    res.status(500).send('Error interno al generar guardias');
  }
});
router.get('/informe', (req, res) => {
  res.render('guardias_informe_form', { hero: false });
});
router.post('/informe', async (req, res) => {
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
    WHERE DATE(e.fecha_inicio) BETWEEN $1 AND $2
    ORDER BY e.fecha_inicio ASC
  `;

  try {
    const result = await db.query(sql, [desde, hasta]);
    const eventos = result.rows;

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-disposition', 'attachment; filename="calendario_guardias.pdf"');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

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

      if (i > 0) doc.addPage();

      // CABECERA
      if (fs.existsSync('./public/logo.png')) {
        doc.image('./public/logo.png', 30, 30, { width: 40 });
      }

      const grupoTexto = eventosPorMes[mesKey][0].grupo || '';
      doc.fontSize(14).text(grupoTexto.toUpperCase(), 100, 30, { align: 'center' });
      doc.fontSize(20).text(primerDia.format('MMMM YYYY').toUpperCase(), { align: 'center' });

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

      doc.fontSize(8).fillColor('gray')
         .text(`Generado el ${dayjs().format('DD/MM/YYYY HH:mm')}`, 0, 800, { align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error('❌ Error al generar informe:', err.message);
    res.status(500).send('Error al generar informe');
  }
});
module.exports = router;