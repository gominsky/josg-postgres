// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const fs = require('fs');
const { isAuthenticated } = require('../middleware/auth');
const { toISODate } = require('../utils/fechas');

// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/lista');
});

router.get('/ficha', async (req, res) => {
  try {
    const gruposResult = await db.query('SELECT * FROM grupos ORDER BY nombre');
    const instrumentosResult = await db.query('SELECT * FROM instrumentos ORDER BY nombre');

    res.render('informe_form', {
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      alumnos: [],
      campos: [],
      nombreInforme: '',
      grupoSeleccionado: 'todos',
      instrumentoSeleccionado: 'todos',
      fechaHoy: new Date().toISOString().split('T')[0], // ISO hoy
      showGroup: false,
      showInstrument: false
    });
  } catch (error) {
    console.error('Error cargando formulario de informe:', error);
    res.status(500).send('Error cargando datos');
  }
});

router.get('/ficha/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const informeResult = await db.query('SELECT * FROM informes WHERE id = $1', [id]);
    const informe = informeResult.rows[0];

    if (!informe) return res.status(404).send('Informe no encontrado');

    const [gruposResult, instrumentosResult, camposResult, alumnosResult, resultadosResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM instrumentos ORDER BY nombre'),
      db.query('SELECT * FROM informe_campos WHERE informe_id = $1 ORDER BY id', [id]),
      db.query('SELECT * FROM alumnos ORDER BY apellidos, nombre'),
      db.query('SELECT * FROM informe_resultados WHERE informe_id = $1', [id])
    ]);

    res.render('informe_form', {
      informeId: id,
      nombreInforme: informe.informe,
      grupoSeleccionado: informe.grupo_id || 'todos',
      instrumentoSeleccionado: informe.instrumento_id || 'todos',
      profesorSeleccionado: null,
      fechaHoy: toISODate(informe.fecha) || new Date().toISOString().split('T')[0],
      fecha_fin: toISODate(informe.fecha) || new Date().toISOString().split('T')[0],
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      campos: camposResult.rows,
      alumnos: alumnosResult.rows,
      resultados: resultadosResult.rows,
      showGroup: false,
      showInstrument: false
    });

  } catch (err) {
    console.error('Error cargando informe:', err);
    res.status(500).send('Error al cargar informe');
  }
});

router.get('/lista', async (req, res) => {
  try {
    const { rows: informes } = await db.query(`
      SELECT inf.id, inf.informe, inf.fecha,
             g.nombre AS grupo,
             i.nombre AS instrumento
      FROM informes inf
      LEFT JOIN grupos g ON inf.grupo_id = g.id
      LEFT JOIN instrumentos i ON inf.instrumento_id = i.id
      ORDER BY inf.fecha DESC
    `);

    informes.forEach(i => {
      i.grupo = i.grupo || 'Ninguno';
      i.instrumento = i.instrumento || 'Ninguno';
      i.fecha = toISODate(i.fecha) || i.fecha; // normaliza para la vista si procede
    });

    res.render('informes_lista', { informes });
  } catch (err) {
    console.error('Error cargando informes:', err);
    res.status(500).send('Error al cargar informes');
  }
});

router.post('/ficha/guardar-json', async (req, res) => {
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

  const fechaISO = toISODate(fecha) || new Date().toISOString().slice(0, 10);
  const grupoIdFinal = ['ninguno', 'todos', '', null, undefined].includes(grupo_id) ? null : Number(grupo_id);
  const instrumentoIdFinal = ['ninguno', 'todos', '', null, undefined].includes(instrumento_id) ? null : Number(instrumento_id);

  try {
    let informeIdFinal = informeId;

    // 1. Crear nuevo informe si no hay ID
    if (!informeIdFinal) {
      const insert = await db.query(
        `INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nombre_informe, grupoIdFinal, instrumentoIdFinal, fechaISO]
      );
      informeIdFinal = insert.rows[0].id;
    } else {
      // Actualizar nombre (y fecha por si quieres mantener el corte)
      await db.query(
        `UPDATE informes SET informe = $1, fecha = $2 WHERE id = $3`,
        [nombre_informe, fechaISO, informeIdFinal]
      );
    }

    // 2. Borrar campos y resultados previos
    await db.query(`DELETE FROM informe_resultados WHERE informe_id = $1`, [informeIdFinal]);
    await db.query(`DELETE FROM informe_campos WHERE informe_id = $1`, [informeIdFinal]);

    // 3. Insertar campos
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const camposIds = [];
    for (const campo of parsedCampos) {
      const r = await db.query(campoInsert, [
        informeIdFinal,
        campo.nombre,
        campo.tipo,
        Boolean(campo.obligatorio)
      ]);
      camposIds.push(r.rows[0].id);
    }

    // 4. Insertar resultados por alumno/campo
    const resultadoInsert = `
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
      VALUES ($1, $2, $3, $4)
    `;
    for (const r of parsedResultados) {
      for (let i = 0; i < camposIds.length; i++) {
        const campoId = camposIds[i];
        const valor = r[`campo_${i}`] ?? '';
        await db.query(resultadoInsert, [
          informeIdFinal,
          r.alumno_id || null,
          campoId,
          valor
        ]);
      }
    }

    res.redirect(`/informes/detalle/${informeIdFinal}`);
  } catch (err) {
    console.error('❌ Error al guardar informe JSON:', err);
    res.status(500).send('Error al guardar informe');
  }
});

router.get('/detalle/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const { rows: [informe] } = await db.query(`
      SELECT i.*, 
             g.nombre AS "informeGrupo", 
             inst.nombre AS "informeInstrumento"
      FROM informes i
      LEFT JOIN grupos g ON i.grupo_id = g.id
      LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
      WHERE i.id = $1
    `, [id]);

    if (!informe) return res.status(404).send('Informe no encontrado');

    const showGroup = informe.grupo_id != null;
    const showInstrument = informe.instrumento_id != null;

    const [{ rows: campos }, { rows: resultados }] = await Promise.all([
      db.query(`SELECT * FROM informe_campos WHERE informe_id = $1 ORDER BY id`, [id]),
      db.query(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = $1 AND (a.id IS NULL OR a.activo = true)
      `, [id])
    ]);

    const filasMap = {};
    for (const r of resultados) {
      const key = r.alumno_id !== null ? `a_${r.alumno_id}` : `f_${r.fila}`;
      if (!filasMap[key]) {
        filasMap[key] = {
          alumno_id: r.alumno_id,
          fila: r.fila,
          nombre: r.nombre || '',
          apellidos: r.apellidos || '',
          valores: {}
        };
      }
      filasMap[key].valores[r.campo_id] = r.valor;
    }

    let filas = Object.values(filasMap);

    for (const f of filas) {
      if (!f.alumno_id) {
        f.grupos = '';
        f.instrumentos = '';
        continue;
      }
      const [gruposRes, instrumentosRes] = await Promise.all([
        db.query(`
          SELECT g.nombre
          FROM grupos g
          JOIN alumno_grupo ag ON ag.grupo_id = g.id
          WHERE ag.alumno_id = $1
          ORDER BY g.nombre
        `, [f.alumno_id]),
        db.query(`
          SELECT i.nombre
          FROM instrumentos i
          JOIN alumno_instrumento ai ON ai.instrumento_id = i.id
          WHERE ai.alumno_id = $1
          ORDER BY i.nombre
        `, [f.alumno_id])
      ]);

      f.grupos = gruposRes.rows.map(r => r.nombre).join(', ');
      f.instrumentos = instrumentosRes.rows.map(r => r.nombre).join(', ');
    }

    filas.sort((a, b) => {
      if (a.alumno_id && b.alumno_id) {
        return a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre);
      }
      if (!a.alumno_id && !b.alumno_id) {
        return (a.fila || 0) - (b.fila || 0);
      }
      return a.alumno_id ? -1 : 1;
    });

    const tieneAlumnos = filas.some(f => f.alumno_id !== null);

    res.render('informes_detalle', {
      informe: { ...informe, fecha: toISODate(informe.fecha) || informe.fecha },
      campos,
      filas,
      tieneAlumnos,
      showGroup,
      showInstrument
    });

  } catch (err) {
    console.error('Error procesando informe:', err);
    res.status(500).send('Error procesando informe');
  }
});

router.post('/detalle/:id', async (req, res) => {
  const id = req.params.id;
  const resultados = JSON.parse(req.body.resultados || '[]');

  try {
    await db.query('DELETE FROM informe_resultados WHERE informe_id = $1', [id]);

    const insertSQL = `
      INSERT INTO informe_resultados (informe_id, alumno_id, fila, campo_id, valor)
      VALUES ($1, $2, $3, $4, $5)
    `;
    for (const r of resultados) {
      const alumnoId = r.alumno_id ?? null;
      const fila = r.fila ?? null;
      const campoId = r.campo_id;
      const valor = r.valor ?? '';
      await db.query(insertSQL, [id, alumnoId, fila, campoId, valor]);
    }
    res.redirect(`/informes/detalle/${id}`);
  } catch (err) {
    console.error('❌ Error guardando resultados del informe:', err);
    res.status(500).send('Error guardando datos del informe');
  }
});

router.post('/ficha/filtrar', async (req, res) => {
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    fecha_fin,
    mostrar_grupo,
    mostrar_instrumento
  } = req.body;

  const showGroup = !!mostrar_grupo;
  const showInstrument = !!mostrar_instrumento;

  const fechaISO = toISODate(fecha);
  const fechaFinISO = toISODate(fecha_fin);

  try {
    let sql = `
      SELECT DISTINCT a.id, a.nombre, a.apellidos
      FROM alumnos a
      LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
      LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
      WHERE a.activo = true
    `;
    const params = [];
    let i = 1;

    if (grupo_id !== 'todos') {
      if (grupo_id === 'ninguno') {
        sql += ' AND ag.grupo_id IS NULL';
      } else {
        sql += ` AND ag.grupo_id = $${i++}`;
        params.push(grupo_id);
      }
    }

    if (instrumento_id !== 'todos') {
      if (instrumento_id === 'ninguno') {
        sql += ' AND ai.instrumento_id IS NULL';
      } else {
        sql += ` AND ai.instrumento_id = $${i++}`;
        params.push(instrumento_id);
      }
    }

    sql += ' ORDER BY a.apellidos, a.nombre';

    const { rows: alumnosBase } = await db.query(sql, params);

    const alumnos = await Promise.all(alumnosBase.map(async a => {
      const [gruposRes, instrumentosRes] = await Promise.all([
        db.query(`
          SELECT g.nombre
          FROM grupos g
          JOIN alumno_grupo ag ON g.id = ag.grupo_id
          WHERE ag.alumno_id = $1
        `, [a.id]),
        db.query(`
          SELECT i.nombre
          FROM instrumentos i
          JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
          WHERE ai.alumno_id = $1
        `, [a.id])
      ]);

      return {
        id: a.id,
        nombre: a.nombre,
        apellidos: a.apellidos,
        grupos: gruposRes.rows.map(r => r.nombre).join(', '),
        instrumentos: instrumentosRes.rows.map(r => r.nombre).join(', ')
      };
    }));

    const [gruposRes, instrumentosRes] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM instrumentos ORDER BY nombre')
    ]);

    res.render('informe_form', {
      grupos: gruposRes.rows,
      instrumentos: instrumentosRes.rows,
      alumnos,
      campos: [],
      nombreInforme: nombre_informe,
      grupoSeleccionado: grupo_id,
      instrumentoSeleccionado: instrumento_id,
      profesorSeleccionado: null,
      fechaHoy: fechaISO || new Date().toISOString().slice(0, 10),
      fecha_fin: fechaFinISO || '',
      showGroup,
      showInstrument
    });

  } catch (err) {
    console.error('Error en /ficha/filtrar:', err);
    res.status(500).send('Error al procesar formulario');
  }
});

router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.query('DELETE FROM informe_resultados WHERE informe_id = $1', [id]);
    await db.query('DELETE FROM informe_campos WHERE informe_id = $1', [id]);
    await db.query('DELETE FROM informes WHERE id = $1', [id]);

    res.redirect('/informes/lista');
  } catch (err) {
    console.error('Error al eliminar informe:', err);
    res.status(500).send('Error al eliminar informe');
  }
});

router.get('/certificados', async (req, res) => {
  try {
    const [gruposRes, instrumentosRes] = await Promise.all([
      db.query('SELECT id, nombre FROM grupos ORDER BY nombre'),
      db.query('SELECT id, nombre FROM instrumentos ORDER BY nombre')
    ]);

    res.render('informes_y_certificados', {
      title: 'Informes y Certificados',
      hero: false,
      grupos: gruposRes.rows,
      instrumentos: instrumentosRes.rows
    });
  } catch (err) {
    console.error('Error cargando certificados:', err);
    res.status(500).send('Error cargando certificados');
  }
});

// === INFORME DE HORAS (construyendo start_ts / end_ts robustos) ===
router.get('/horas', isAuthenticated, async (req, res) => {
  const fechaISO = toISODate(req.query.fecha);
  const fechaFinISO = toISODate(req.query.fecha_fin);
  const grupo = req.query.grupo;
  const instrumento = req.query.instrumento;

  const fromParam = fechaISO ? `${fechaISO} 00:00:00` : null;
  const toParam   = fechaFinISO ? `${fechaFinISO} 23:59:59` : null;

  try {
    // 1) Total de horas del periodo
    const totalParams = [];
    let totalWhere = '';

    if (fromParam) { totalParams.push(fromParam); totalWhere += (totalWhere ? ' AND ' : ' WHERE ') + `e.start_ts >= $${totalParams.length}`; }
    if (toParam)   { totalParams.push(toParam);   totalWhere += (totalWhere ? ' AND ' : ' WHERE ') + `e.end_ts   <= $${totalParams.length}`; }
    if (grupo)     { totalParams.push(grupo);     totalWhere += (totalWhere ? ' AND ' : ' WHERE ') + `e.grupo_id = $${totalParams.length}`; }

    const totalSQL = `
      WITH e AS (
        SELECT
          ev.*,
          (
            (
              CASE WHEN position('T' in ev.fecha_inicio) > 0
                   THEN split_part(ev.fecha_inicio, 'T', 1)
                   ELSE ev.fecha_inicio
              END
            ) || ' ' || COALESCE(ev.hora_inicio, '00:00') || ':00'
          )::timestamp AS start_ts,
          (
            (
              CASE WHEN position('T' in ev.fecha_fin) > 0
                   THEN split_part(ev.fecha_fin, 'T', 1)
                   ELSE ev.fecha_fin
              END
            ) || ' ' || COALESCE(ev.hora_fin, '23:59') || ':00'
          )::timestamp AS end_ts
        FROM eventos ev
      )
      SELECT SUM(EXTRACT(EPOCH FROM (e.end_ts - e.start_ts)) / 3600.0) AS total_horas
      FROM e
      ${totalWhere}
    `;
    const totalRes = await db.query(totalSQL, totalParams);
    const totalHoras = parseFloat(totalRes.rows[0].total_horas || 0);

    // 2) Horas por alumno (solo asistencias manual/qr)
    const alumnoParams = [];
    let alumnoWhere = `WHERE asi.tipo IN ('manual','qr')`;

    // Filtros sobre timestamps calculados
    if (fromParam) { alumnoParams.push(fromParam); alumnoWhere += ` AND e.start_ts >= $${alumnoParams.length}`; }
    if (toParam)   { alumnoParams.push(toParam);   alumnoWhere += ` AND e.end_ts   <= $${alumnoParams.length}`; }
    if (grupo)     { alumnoParams.push(grupo);     alumnoWhere += ` AND e.grupo_id = $${alumnoParams.length}`; }

    let instrumentoJoin = '';
    if (instrumento) {
      alumnoParams.push(instrumento);
      instrumentoJoin = `JOIN alumno_instrumento ai ON ai.alumno_id = a.id AND ai.instrumento_id = $${alumnoParams.length}`;
    }

    const alumnoSQL = `
      WITH e AS (
        SELECT
          ev.*,
          (
            (
              CASE WHEN position('T' in ev.fecha_inicio) > 0
                   THEN split_part(ev.fecha_inicio, 'T', 1)
                   ELSE ev.fecha_inicio
              END
            ) || ' ' || COALESCE(ev.hora_inicio, '00:00') || ':00'
          )::timestamp AS start_ts,
          (
            (
              CASE WHEN position('T' in ev.fecha_fin) > 0
                   THEN split_part(ev.fecha_fin, 'T', 1)
                   ELSE ev.fecha_fin
              END
            ) || ' ' || COALESCE(ev.hora_fin, '23:59') || ':00'
          )::timestamp AS end_ts
        FROM eventos ev
      )
      SELECT 
        a.id,
        a.nombre || ' ' || a.apellidos AS alumno,
        SUM(EXTRACT(EPOCH FROM (e.end_ts - e.start_ts)) / 3600.0) AS horas
      FROM asistencias asi
      JOIN alumnos a ON asi.alumno_id = a.id
      JOIN e ON asi.evento_id = e.id
      ${instrumentoJoin}
      ${alumnoWhere}
      GROUP BY a.id, a.nombre, a.apellidos
      HAVING SUM(EXTRACT(EPOCH FROM (e.end_ts - e.start_ts)) / 3600.0) > 0
      ORDER BY alumno
    `;
    const alumnosRes = await db.query(alumnoSQL, alumnoParams);

    const resultados = alumnosRes.rows.map(r => {
      const horas = parseFloat(r.horas);
      const porcentaje = totalHoras > 0 ? (horas / totalHoras) * 100 : 0;
      return {
        id: r.id,
        alumno: r.alumno,
        horas: horas.toFixed(2),
        porcentaje: porcentaje.toFixed(1)
      };
    });

    res.render('informes_horas', {
      fecha: fechaISO || '',
      fecha_fin: fechaFinISO || '',
      grupo,
      instrumento,
      totalHoras,
      resultados
    });

  } catch (err) {
    console.error('❌ Error calculando informe de horas:', err);
    res.status(500).send('Error calculando informe de horas');
  }
});

router.post('/horas/guardar', isAuthenticated, async (req, res) => {
  const { fecha, fecha_fin, grupo, instrumento, resultados } = req.body;
  const parsed = JSON.parse(resultados || '[]');

  const fISO = toISODate(fecha);
  const ffISO = toISODate(fecha_fin);

  const opts = { day: '2-digit', month: 'long', year: 'numeric' };
  const fi = fISO ? new Date(`${fISO}T00:00:00`).toLocaleDateString('es-ES', opts) : '';
  const ff = ffISO ? new Date(`${ffISO}T00:00:00`).toLocaleDateString('es-ES', opts) : null;

  const nombreInforme = `Porcentaje de horas de asistencia (${fi}` + (ff ? ` – ${ff}` : '') + `)`;

  try {
    // 1) Crear informe (guardo como fecha de informe el fin si existe, si no el inicio)
    const result = await db.query(`
      INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [
      nombreInforme,
      (grupo === 'todos' || grupo === '' || grupo == null) ? null : parseInt(grupo, 10),
      (instrumento === 'todos' || instrumento === '' || instrumento == null) ? null : parseInt(instrumento, 10),
      ffISO || fISO || new Date().toISOString().slice(0, 10)
    ]);
    const informeId = result.rows[0].id;

    // 2) Campos
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, false)
      RETURNING id
    `;
    const campoAlumno = (await db.query(campoInsert, [informeId, 'Alumno', 'numero'])).rows[0].id;
    const campoHoras = (await db.query(campoInsert, [informeId, 'Horas', 'numero'])).rows[0].id;
    const campoPorcentaje = (await db.query(campoInsert, [informeId, 'Porcentaje', 'numero'])).rows[0].id;

    // 3) Resultados
    const resInsert = `
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
      VALUES ($1, $2, $3, $4)
    `;
    for (const r of parsed) {
      await db.query(resInsert, [informeId, r.alumno_id, campoAlumno, String(r.alumno_id)]);
      await db.query(resInsert, [informeId, r.alumno_id, campoHoras, String(r.horas)]);
      await db.query(resInsert, [informeId, r.alumno_id, campoPorcentaje, String(r.porcentaje)]);
    }

    res.redirect(`/informes/detalle/${informeId}`);
  } catch (err) {
    console.error('❌ Error al guardar informe de horas:', err);
    res.status(500).send('Error al guardar el informe');
  }
});

module.exports = router;
