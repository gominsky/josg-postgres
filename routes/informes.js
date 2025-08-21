// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const fs = require('fs');
const { isAuthenticated } = require('../middleware/auth');
const { toISODate } = require('../utils/fechas');
router.use(express.json());
// ⛔️ Anti-caché para todo lo de /ficha (GET y POST)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_informes', { title: 'Ayuda · Informes y certificados', hero: false });
});
router.use('/ficha', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/certificados');
});

router.get('/ficha', async (req, res) => {
  try {
    const [gruposResult, instrumentosResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM instrumentos ORDER BY nombre')
    ]);

    const q = req.query || {};
    const norm = v => (v == null ? '' : String(v));

    const rawGrupo = norm(q.grupo);          // 'todos' | 'ninguno' | <id> | ''
    const rawInst  = norm(q.instrumento);    // 'todos' | <id> | ''
    const f1ISO    = toISODate(q.fecha);
    const f2ISO    = toISODate(q.fecha_fin); // no lo usamos para alumnos, sólo para nombre si quisieras

    // Mapeo robusto ('' → 'todos')
    const selGrupo = rawGrupo === '' ? 'todos' : rawGrupo;
    const selInst  = rawInst  === '' ? 'todos' : rawInst;

    let alumnos  = [];
    let filtrado = false;

    // Si venimos desde “Informes y certificados” con algún filtro, filtramos YA
    const vieneConFiltros = (rawGrupo !== '' || rawInst !== '' || !!f1ISO);
    if (vieneConFiltros) {
      filtrado = true;

      // Sólo “sin alumnos” si el grupo es literalmente 'ninguno'
      if (selGrupo !== 'ninguno') {
        let sql = `
          SELECT DISTINCT a.id, a.nombre, a.apellidos
          FROM alumnos a
          LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
          LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
          WHERE a.activo = true
        `;
        const params = [];
        let i = 1;

        if (selGrupo !== 'todos') {
          sql += ` AND ag.grupo_id = $${i++}`;
          params.push(selGrupo);
        }
        if (selInst !== 'todos') {
          sql += ` AND ai.instrumento_id = $${i++}`;
          params.push(selInst);
        }

        sql += ' ORDER BY a.apellidos, a.nombre';

        const { rows: base } = await db.query(sql, params);

        // añade nombres de grupos/instrumentos de cada alumno
        alumnos = await Promise.all(base.map(async a => {
          const [gRes, iRes] = await Promise.all([
            db.query(`
              SELECT g.nombre
              FROM grupos g
              JOIN alumno_grupo ag ON g.id = ag.grupo_id
              WHERE ag.alumno_id = $1
              ORDER BY g.nombre
            `, [a.id]),
            db.query(`
              SELECT i.nombre
              FROM instrumentos i
              JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
              WHERE ai.alumno_id = $1
              ORDER BY i.nombre
            `, [a.id])
          ]);
          return {
            id: a.id,
            nombre: a.nombre,
            apellidos: a.apellidos,
            grupos: gRes.rows.map(r => r.nombre).join(', '),
            instrumentos: iRes.rows.map(r => r.nombre).join(', ')
          };
        }));
      }
    }

    // Resuelve nombre legible (ids -> nombres) para el título sugerido
    const nombreDeGrupo = (() => {
      if (selGrupo === 'todos') return 'Todos';
      if (selGrupo === 'ninguno') return 'Ninguno';
      const g = gruposResult.rows.find(x => String(x.id) === String(selGrupo));
      return g ? g.nombre : (selGrupo || '');
    })();
    const nombreDeInstr = (() => {
      if (selInst === 'todos') return 'Todos';
      const i = instrumentosResult.rows.find(x => String(x.id) === String(selInst));
      return i ? i.nombre : (selInst || '');
    })();

    // Nombre sugerido sin fecha_fin ni guiones
    const construirNombreSugerido = ({ g, i, d1 }) => {
      const partes = ['Listado'];
      if (g) partes.push(g === 'Ninguno' ? 'Sin alumnos' : `Grupo ${g}`);
      if (i) partes.push(`Instr. ${i}`);
      if (d1) partes.push(d1);
      return partes.join(' ');
    };
    const nombreInforme = construirNombreSugerido({
      g: nombreDeGrupo,
      i: nombreDeInstr,
      d1: f1ISO || ''
    });

    res.render('informe_form', {
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      alumnos,                  // ← ya filtrados (o vacío si 'ninguno')
      campos: [],
      nombreInforme,
      grupoSeleccionado: selGrupo,
      instrumentoSeleccionado: selInst,
      profesorSeleccionado: null,
      fechaHoy: f1ISO || new Date().toISOString().slice(0,10),
      fecha_fin: '',            // ya no mostramos fecha_fin en el título
      showGroup: false,
      showInstrument: false,
      desdeIC: vieneConFiltros, // oculta selects y pinta “Filtros recibidos”
      filtrado
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
  const parsedCampos     = JSON.parse(campos_json || '[]');

  // ---- Normalización y AUTO-CAMPOS "Prueba de atril ..." ----
  const norm = (s) => (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .replace(/[^\w\s]/g, ' ')                           // quita punct.
    .replace(/\s+/g, ' ')                               // espacios a 1
    .trim();

  const esPruebaAtril = norm(nombre_informe).startsWith('prueba de atril');

  // Limpia/normaliza el array recibido
  const normalizeCampo = (c) => ({
    nombre: (c?.nombre ?? '').toString().trim(),
    tipo: ['texto','numero','booleano'].includes(c?.tipo) ? c.tipo : 'texto',
    obligatorio: !!c?.obligatorio
  });
  let camposWork = parsedCampos.map(normalizeCampo);

  if (esPruebaAtril) {
    const tieneNombre = (arr, ...nombres) =>
      arr.some(c => nombres.some(n => norm(c.nombre) === norm(n)));

    if (!tieneNombre(camposWork, 'Puntuación', 'Puntuacion')) {
      camposWork.push({ nombre: 'Puntuación', tipo: 'numero',   obligatorio: false });
    }
    if (!tieneNombre(camposWork, 'Asistencia')) {
      camposWork.push({ nombre: 'Asistencia', tipo: 'booleano', obligatorio: false });
    }
  }
  // ---- FIN AUTO-CAMPOS ----

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
      // Actualizar nombre y fecha
      await db.query(
        `UPDATE informes SET informe = $1, fecha = $2 WHERE id = $3`,
        [nombre_informe, fechaISO, informeIdFinal]
      );
    }

    // 2. Borrar campos y resultados previos
    await db.query(`DELETE FROM informe_resultados WHERE informe_id = $1`, [informeIdFinal]);
    await db.query(`DELETE FROM informe_campos WHERE informe_id = $1`, [informeIdFinal]);

    // 3. Insertar campos (usando el array ya normalizado + posibles auto-campos)
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const camposIds = [];
    for (const campo of camposWork) {
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
        // Si añadimos auto-campos en servidor, no habrá valor: caerá a '' (ok)
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

  const fechaISO    = toISODate(fecha)     || new Date().toISOString().slice(0, 10);
  const fechaFinISO = toISODate(fecha_fin) || fechaISO;
  
    
  try {
    // 👉 Modo "sin alumnos" literal
    if (grupo_id === 'ninguno') {
      const [gruposRes, instrumentosRes] = await Promise.all([
        db.query('SELECT * FROM grupos ORDER BY nombre'),
        db.query('SELECT * FROM instrumentos ORDER BY nombre')
      ]);

      return res.render('informe_form', {
        grupos: gruposRes.rows,
        instrumentos: instrumentosRes.rows,
        alumnos: [],                     // sin alumnos
        campos: [],
        nombreInforme: nombre_informe,
        grupoSeleccionado: 'ninguno',    // activa el mensaje "sin alumnos"
        instrumentoSeleccionado: instrumento_id || 'todos',
        profesorSeleccionado: null,
        fechaHoy: fechaISO || new Date().toISOString().slice(0, 10),
        fecha_fin: fechaFinISO || '',
        showGroup,
        showInstrument,
        filtrado: true
      });
    }
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
      db.query('SELECT id, nombre FROM grupos ORDER BY nombre'),
      db.query('SELECT id, nombre FROM instrumentos ORDER BY nombre')
    ]);

    // Sugerir nombre si viene vacío
    const gName = (() => {
      if (grupo_id === 'todos')   return null;
      if (grupo_id === 'ninguno') return 'Ninguno';
      const g = gruposRes.rows.find(x => String(x.id) === String(grupo_id));
      return g ? g.nombre : null;
    })();
    const iName = (() => {
      if (instrumento_id === 'todos') return null;
      const i = instrumentosRes.rows.find(x => String(x.id) === String(instrumento_id));
      return i ? i.nombre : null;
    })();
    const sugerido = (() => {
      const piezas = ['Listado'];
      if (gName) piezas.push(gName === 'Ninguno' ? 'Sin alumnos' : `${gName}`);
      if (iName) piezas.push(`${iName}`);
      if (fechaISO) piezas.push(fechaISO);   // sin fecha_fin
      return piezas.join(' ');
    })();    
    res.render('informe_form', {
      grupos: gruposRes.rows,
      instrumentos: instrumentosRes.rows,
      alumnos,
      campos: [],
      nombreInforme: nombre_informe && nombre_informe.trim() ? nombre_informe.trim() : sugerido,
      grupoSeleccionado: grupo_id,
      instrumentoSeleccionado: instrumento_id,
      profesorSeleccionado: null,
      fechaHoy: fechaISO,
      fecha_fin: fechaFinISO,
      showGroup,
      showInstrument,
      desdeIC: true,                                                     // 👈 mantenemos el modo “solo nombre” en el paso 1
      filtrado: (grupo_id === 'ninguno') || (alumnos && alumnos.length)  // 👈 para “saltar” al paso 2
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

// Actualizar solo el título del informe (AJAX)
router.post('/:id/titulo', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  let   titulo = (req.body?.titulo || '').toString().trim();

  // Permite títulos largos (ajusta a tus límites reales)
  const MAX_LEN = 255;               // sube a 500 o usa TEXT si quieres “sin límite”
  titulo = titulo.slice(0, MAX_LEN);

  try {
    const { rowCount } = await db.query(
      'UPDATE informes SET informe = $1 WHERE id = $2',
      [titulo, id]
    );
    if (rowCount === 0) return res.status(404).json({ ok:false, msg:'Informe no encontrado' });
    return res.json({ ok:true, titulo });
  } catch (e) {
    console.error('❌ Error actualizando título:', e.message);
    return res.status(500).json({ ok:false });
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
