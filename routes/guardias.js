// routes/guardias.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');

const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

const { generarPdfGuardias } = require('../utils/pdfGuardias');
const { toISODate } = require('../utils/fechas');

/* =========================
   Helpers de curso/rollover
   ========================= */
const getCursoActual = () => {
  const hoy = new Date();
  const y = hoy.getFullYear();
  // 0=ene … 8=sep → desde sep pertenece a y/(y+1)
  return hoy.getMonth() >= 8 ? `${y}/${y+1}` : `${y-1}/${y}`;
};

// Resetea guardias_actual cuando empieza curso nuevo, sin tablas auxiliares.
async function ensureRolloverSiToca(db) {
  const cursoNuevo = getCursoActual();

  // ¿ya hay alguna guardia del curso nuevo?
  const { rows } = await db.query(
    `SELECT EXISTS(SELECT 1 FROM guardias WHERE curso = $1) AS hay_actual`,
    [cursoNuevo]
  );
  const hayActual = rows[0]?.hay_actual;

  if (hayActual) return; // ya estamos en el curso nuevo con al menos una guardia, no tocar

  // Si aún no hay guardias del curso nuevo, aseguramos que guardias_actual esté a 0 (idempotente).
  await db.query(`UPDATE alumnos SET guardias_actual = 0 WHERE guardias_actual <> 0`);
}

/* ==========================================
   Detección dinámica columna de matriculación
   ========================================== */
let MAT_COL; // cache: string | null | undefined
async function getMatriculaColumnName(dbOrClient) {
  if (MAT_COL !== undefined) return MAT_COL;
  const candidatos = ['fecha_matricula','fecha_alta','matricula','f_matricula','fecha_inscripcion'];
  const { rows } = await dbOrClient.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'alumnos'
        AND column_name = ANY($1)
      ORDER BY array_position($1, column_name)
      LIMIT 1`,
    [candidatos]
  );
  MAT_COL = rows[0]?.column_name || null;
  if (MAT_COL) {
    console.log(`ℹ️ Usando columna de matrícula: ${MAT_COL}`);
  } else {
    console.warn('⚠️ No se encontró columna de matrícula en "alumnos"; se desactiva la regla de novatos.');
  }
  return MAT_COL;
}

/* ==================
   Reglas de "novato"
   ================== */
// 1 de enero del año base del curso (curso empieza en septiembre).
function corteDelCurso(fechaRef) {
  const d = new Date(fechaRef);
  const baseYear = (d.getMonth() >= 8) ? d.getFullYear() : (d.getFullYear() - 1); // 8=sep
  return new Date(baseYear, 0, 1);
}
// Novato si: matrícula >= corteDelCurso(fechaRef) Y guardias_actual < 2
function esNovatoAlumno(alumno, fechaRef) {
  if (!alumno || !('fecha_matricula' in alumno) || !alumno.fecha_matricula) return false;
  const corte = corteDelCurso(fechaRef);
  const mat = new Date(alumno.fecha_matricula);
  const ga  = Number(alumno.guardias_actual || 0);
  return mat >= corte && ga < 2;
}

/* =========================
   LISTADO (BUSCADOR SIMPLE)
   ========================= */
router.get('/', async (req, res) => {
  await ensureRolloverSiToca(db);

  const { desde, hasta, busqueda, grupo } = req.query;
  const desdeISO = toISODate(desde);
  const hastaISO = toISODate(hasta);

  try {
    const gruposResult = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const grupos = gruposResult.rows;

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

    if (desdeISO) { condiciones.push(`DATE(e.fecha_inicio) >= DATE($${params.length + 1})`); params.push(desdeISO); }
    if (hastaISO) { condiciones.push(`DATE(e.fecha_inicio) <= DATE($${params.length + 1})`); params.push(hastaISO); }

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

    if (condiciones.length > 0) sql += ' WHERE ' + condiciones.join(' AND ');
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

/* =========
   PLANILLA
   ========= */
// GET /guardias y /guardias/mostrar
router.get(['/', '/mostrar'], async (req, res) => {
  await ensureRolloverSiToca(db);
  try {
    let { desde = '', hasta = '', grupo = '' } = req.query;
    const params = [];
    const where  = [];

    // Filtramos por fechas del EVENTO (no por gu.fecha texto)
    if (desde) {
      params.push(desde);
      where.push(`e.fecha_inicio::date >= $${params.length}::date`);
    }
    if (hasta) {
      params.push(hasta);
      where.push(`e.fecha_inicio::date <= $${params.length}::date`);
    }
    if (grupo && grupo !== '' && grupo !== 'todos') {
      params.push(grupo);
      where.push(`e.grupo_id = $${params.length}`);
    }

    const sql = `
      SELECT
        e.id                 AS evento_id,
        e.titulo             AS evento,
        e.fecha_inicio,
        e.fecha_fin,
        g.nombre             AS grupo,
        gu.id                AS guardia_id,
        COALESCE(a1.apellidos || ', ' || a1.nombre, '-') AS guardia1,
        COALESCE(a2.apellidos || ', ' || a2.nombre, '-') AS guardia2
      FROM eventos e
      LEFT JOIN grupos    g  ON g.id  = e.grupo_id
      LEFT JOIN guardias  gu ON gu.evento_id = e.id
      LEFT JOIN alumnos   a1 ON a1.id = gu.alumno_id_1
      LEFT JOIN alumnos   a2 ON a2.id = gu.alumno_id_2
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.fecha_inicio ASC
      LIMIT 500;
    `;

    const { rows: guardias } = await db.query(sql, params);
    const { rows: grupos    } = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre ASC');

    res.render('guardias_mostrar', {
      title: 'Planilla de guardias',
      hero: false,
      guardias, grupos, desde, hasta, grupo
    });
  } catch (e) {
    console.error(e);
    res.render('guardias_mostrar', {
      title: 'Planilla de guardias',
      hero: false,
      guardias: [],
      grupos: [],
      desde: '',
      hasta: '',
      grupo: ''
    });
  }
});

router.get('/evento/:eventoId', async (req, res) => {
  const { eventoId } = req.params;

  try {
    const result = await db.query('SELECT * FROM guardias WHERE evento_id = $1', [eventoId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ mensaje: 'No se encontraron guardias para este evento.' });
    }
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener guardias:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ==============================
   GENERAR UNA GUARDIA AUTOMÁTICA
   ============================== */
router.post('/generar', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { evento_id, desde, hasta } = req.body;
  const curso = getCursoActual();
  const client = await db.connect();

  try {
    // Datos del evento
    const eventoResult = await client.query(
      `SELECT fecha_inicio, grupo_id FROM eventos WHERE id = $1`,
      [evento_id]
    );
    const evento = eventoResult.rows[0];
    if (!evento) {
      client.release();
      return res.status(404).send('Evento no encontrado');
    }

    const fechaStr = toISODate(evento.fecha_inicio); // "YYYY-MM-DD"
    const grupo_id = evento.grupo_id;

    // Alumnos activos del grupo (trae matrícula si existe)
    const matCol = await getMatriculaColumnName(client);
    const cols = `a.id, a.nombre, a.apellidos, a.guardias_actual${matCol ? `, a.${matCol} AS fecha_matricula` : ''}`;
    const alumnosResult = await client.query(`
      SELECT ${cols}
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = TRUE
    `, [grupo_id]);
    const alumnos = alumnosResult.rows;

    // Ocupados ese día
    const ocupadosResult = await client.query(`
      SELECT alumno_id_1, alumno_id_2 FROM guardias WHERE DATE(fecha) = DATE($1)
    `, [fechaStr]);
    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });

    const disponibles = alumnos.filter(a => !ocupados.has(a.id));
    if (!disponibles.length) {
      req.session.error = 'Sin alumnos disponibles para esta fecha';
      client.release();
      return res.redirect('/guardias');
    }

    // Parejas por menor carga evitando novato+novato (según fecha del evento)
    let parejas = [];
    for (let i = 0; i < disponibles.length; i++) {
      for (let j = i + 1; j < disponibles.length; j++) {
        const p = [disponibles[i], disponibles[j]];
        if (esNovatoAlumno(p[0], evento.fecha_inicio) && esNovatoAlumno(p[1], evento.fecha_inicio)) continue; // ⛔️
        parejas.push(p);
      }
    }
    parejas = parejas
      .sort(() => Math.random() - 0.5)
      .sort((a, b) => ((a[0].guardias_actual||0)+(a[1].guardias_actual||0)) - ((b[0].guardias_actual||0)+(b[1].guardias_actual||0)));

    if (!parejas.length) {
      req.session.error = 'No hay parejas válidas para esta guardia';
      client.release();
      return res.redirect('/guardias');
    }

    const [a1, a2] = parejas[0];

    await client.query('BEGIN');

    // Evitar guardia duplicada para este evento
    const dup = await client.query(`SELECT 1 FROM guardias WHERE evento_id = $1`, [evento_id]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      client.release();
      req.session.error = 'Este evento ya tiene guardia asignada.';
      return res.redirect('/guardias');
    }

    await client.query(`
      INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
      VALUES ($1, $2, $3, $4, $5, NULL)
    `, [evento_id, fechaStr, a1.id, a2.id, curso]);

    // Actual y Histórico (conteo por asignación)
    await client.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1, guardias_hist = guardias_hist + 1 WHERE id = $1`, [a1.id]);
    await client.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1, guardias_hist = guardias_hist + 1 WHERE id = $1`, [a2.id]);

    await client.query('COMMIT');

    req.session.mensaje = 'Guardia sugerida correctamente ✅';
    const query = `?desde=${encodeURIComponent(desde || '')}&hasta=${encodeURIComponent(hasta || '')}`;
    res.redirect('/guardias' + query);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('❌ Error al generar guardia:', error);
    res.status(500).send('Error al generar guardia');
  } finally {
    client.release();
  }
});

/* ======
   EDITAR
   ====== */
router.get('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { desde, hasta, grupo } = req.query;

  try {
    // Guardia + evento
    const result = await db.query(`
      SELECT g.*, e.titulo AS evento, e.grupo_id, e.fecha_inicio
      FROM guardias g
      JOIN eventos e ON g.evento_id = e.id
      WHERE g.id = $1
    `, [id]);

    const guardia = result.rows[0];
    if (!guardia) return res.status(404).send('Guardia no encontrada');

    // Alumnos activos del grupo
    const alumnosResult = await db.query(`
      SELECT a.id, a.nombre, a.apellidos, a.guardias_actual
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = TRUE
    `, [guardia.grupo_id]);
    const alumnos = alumnosResult.rows;

    // Ocupados ese día (excluyendo la guardia actual)
    const ocupadosResult = await db.query(`
      SELECT alumno_id_1, alumno_id_2
      FROM guardias
      WHERE DATE(fecha) = DATE($1) AND id <> $2
    `, [toISODate(guardia.fecha), id]);

    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });

    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    // Parejas posibles (informativas)
    let parejas = [];
    for (let i = 0; i < disponibles.length; i++) {
      for (let j = i + 1; j < disponibles.length; j++) {
        parejas.push([disponibles[i], disponibles[j]]);
      }
    }
    parejas = parejas
      .sort(() => Math.random() - 0.5)
      .sort((a, b) => ((a[0].guardias_actual||0)+(a[1].guardias_actual||0)) - ((b[0].guardias_actual||0)+(b[1].guardias_actual||0)));

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

// Guardar cambios en una guardia (y ajustar contadores si cambian alumnos)
router.post('/guardar', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { id, alumno_id_1, alumno_id_2, notas, desde, hasta, grupo } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1) Fecha (día) de la guardia que estamos editando
    const metaRes = await client.query(
      `SELECT DATE(fecha) AS dia FROM guardias WHERE id = $1`,
      [id]
    );
    if (metaRes.rowCount === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).send('Guardia no encontrada');
    }
    const dia = metaRes.rows[0].dia; // 'YYYY-MM-DD'

    // 2) Asignación previa
    const prevRes = await client.query(
      `SELECT alumno_id_1, alumno_id_2 FROM guardias WHERE id = $1`,
      [id]
    );
    const prev = prevRes.rows[0];
    const prevSet = new Set([prev.alumno_id_1, prev.alumno_id_2].filter(Boolean));
    const n1 = alumno_id_1 ? Number(alumno_id_1) : null;
    const n2 = alumno_id_2 ? Number(alumno_id_2) : null;
    const newSet  = new Set([n1, n2].filter(Boolean));

    // 3) Comprobar ocupación ese día (excluyendo esta guardia)
    if (n1) {
      const r1 = await client.query(
        `SELECT 1 FROM guardias
         WHERE DATE(fecha) = $1
           AND id <> $2
           AND ($3 IN (alumno_id_1, alumno_id_2))`,
        [dia, id, n1]
      );
      if (r1.rowCount > 0) {
        await client.query('ROLLBACK');
        client.release();
        req.session.mensaje = '⚠️ El alumno 1 ya tiene guardia ese día.';
        const qs = buildQs({ desde, hasta, grupo });
        return res.redirect('/guardias' + qs);
      }
    }
    if (n2) {
      const r2 = await client.query(
        `SELECT 1 FROM guardias
         WHERE DATE(fecha) = $1
           AND id <> $2
           AND ($3 IN (alumno_id_1, alumno_id_2))`,
        [dia, id, n2]
      );
      if (r2.rowCount > 0) {
        await client.query('ROLLBACK');
        client.release();
        req.session.mensaje = '⚠️ El alumno 2 ya tiene guardia ese día.';
        const qs = buildQs({ desde, hasta, grupo });
        return res.redirect('/guardias' + qs);
      }
    }

    // 3bis) Evitar novato+novato en edición manual (usa el día de la guardia para el corte)
    if (n1 && n2) {
      const matCol = await getMatriculaColumnName(client);
      let selectCols = 'id, guardias_actual';
      if (matCol) selectCols = `id, ${matCol} AS fecha_matricula, guardias_actual`;

      const novRes = await client.query(
        `SELECT ${selectCols} FROM alumnos WHERE id = ANY($1::int[])`,
        [[n1, n2]]
      );
      const mapa = Object.fromEntries(novRes.rows.map(r => [r.id, r]));
      const aN1 = mapa[n1], aN2 = mapa[n2];

      const esN1 = esNovatoAlumno(aN1, dia);
      const esN2 = esNovatoAlumno(aN2, dia);

      if (esN1 && esN2) {
        await client.query('ROLLBACK');
        client.release();
        req.session.mensaje = '⚠️ No se puede asignar a dos novatos en la misma guardia.';
        const qs = buildQs({ desde, hasta, grupo });
        return res.redirect('/guardias' + qs);
      }
    }

    // 4) Actualizar guardia
    await client.query(`
      UPDATE guardias
         SET alumno_id_1 = $1,
             alumno_id_2 = $2,
             notas = $3
       WHERE id = $4
    `, [n1, n2, (notas || ''), id]);

    // 5) Ajustar contadores (actual + histórico) según cambios
    const removed = [...prevSet].filter(x => !newSet.has(x));
    const added   = [...newSet].filter(x => !prevSet.has(x));

    for (const uid of removed) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0),
               guardias_hist   = GREATEST(guardias_hist - 1, 0)
         WHERE id = $1
      `, [uid]);
    }
    for (const uid of added) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = guardias_actual + 1,
               guardias_hist    = guardias_hist + 1
         WHERE id = $1
      `, [uid]);
    }

    await client.query('COMMIT');

    const qs = buildQs({ desde, hasta, grupo });
    res.redirect('/guardias' + qs);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al guardar guardia:', err);
    res.status(500).send('Error al guardar guardia');
  } finally {
    client.release();
  }
});

/* ==============
   Helper de QS
   ============== */
function buildQs({ desde, hasta, grupo }) {
  const params = [];
  if (desde) params.push(`desde=${encodeURIComponent(desde)}`);
  if (hasta) params.push(`hasta=${encodeURIComponent(hasta)}`);
  if (grupo) params.push(`grupo=${encodeURIComponent(grupo)}`);
  return params.length ? `?${params.join('&')}` : '';
}

/* =======================
   ELIMINAR UNA GUARDIA
   ======================= */
router.post('/eliminar/:id', async (req, res) => {
  await ensureRolloverSiToca(db);
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

    // 3) Decrementar actual e histórico (mínimo 0)
    if (alumno_id_1) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0),
               guardias_hist    = GREATEST(guardias_hist - 1, 0)
         WHERE id = $1
      `, [alumno_id_1]);
    }
    if (alumno_id_2) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0),
               guardias_hist    = GREATEST(guardias_hist - 1, 0)
         WHERE id = $1
      `, [alumno_id_2]);
    }

    await client.query('COMMIT');

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

/* ==============================
   GENERAR GUARDIAS MÚLTIPLES
   ============================== */
router.post('/generar-multiples', async (req, res) => {
  await ensureRolloverSiToca(db);

  const { desde, hasta, grupo } = req.body;
  const desdeISO = toISODate(desde);
  const hastaISO = toISODate(hasta);
  const curso = getCursoActual();

  try {
    if (!desdeISO || !hastaISO) {
      return res.send('<script>alert("Indica un rango de fechas válido."); window.history.back();</script>');
    }

    let sqlEventos = `
      SELECT e.id AS evento_id, e.fecha_inicio, e.grupo_id
      FROM eventos e
      LEFT JOIN guardias g ON g.evento_id = e.id
      WHERE e.fecha_inicio BETWEEN $1 AND $2 AND g.id IS NULL
    `;
    const paramsEventos = [desdeISO, hastaISO];

    if (grupo) {
      sqlEventos += ' AND e.grupo_id = $3';
      paramsEventos.push(grupo);
    }

    sqlEventos += ' ORDER BY e.fecha_inicio ASC';

    const eventosRes = await db.query(sqlEventos, paramsEventos);
    const eventos = eventosRes.rows;

    if (eventos.length === 0) {
      req.session.mensaje = 'No hay eventos sin guardia en ese rango.';
      return res.redirect('/guardias');
    }

    const ocupadosPorFecha = {};

    for (const evento of eventos) {
      if (!evento.fecha_inicio) continue;

      const fechaStr = toISODate(evento.fecha_inicio); // YYYY-MM-DD

      // Alumnos activos del grupo (trae matrícula si existe)
      const matCol = await getMatriculaColumnName(db);
      const cols = `a.id, a.nombre, a.apellidos, a.guardias_actual${matCol ? `, a.${matCol} AS fecha_matricula` : ''}`;
      const alumnosRes = await db.query(`
        SELECT ${cols}
        FROM alumnos a
        JOIN alumno_grupo ag ON a.id = ag.alumno_id
        WHERE ag.grupo_id = $1 AND a.activo = TRUE
      `, [evento.grupo_id]);

      const alumnos = alumnosRes.rows;
      if (!alumnos.length) continue;

      // Ocupados ese día (cache por fecha)
      if (!ocupadosPorFecha[fechaStr]) {
        const guardiasDiaRes = await db.query(`
          SELECT alumno_id_1, alumno_id_2
          FROM guardias
          WHERE DATE(fecha) = DATE($1)
        `, [fechaStr]);
        const occ = new Set();
        guardiasDiaRes.rows.forEach(g => {
          if (g.alumno_id_1) occ.add(g.alumno_id_1);
          if (g.alumno_id_2) occ.add(g.alumno_id_2);
        });
        ocupadosPorFecha[fechaStr] = occ;
      }
      const ocupados = ocupadosPorFecha[fechaStr];
      const disponibles = alumnos.filter(a => !ocupados.has(a.id));
      if (!disponibles.length) continue;

      // Parejas por menor carga evitando novato+novato
      let parejas = [];
      for (let i = 0; i < disponibles.length; i++) {
        for (let j = i + 1; j < disponibles.length; j++) {
          const p = [disponibles[i], disponibles[j]];
          if (esNovatoAlumno(p[0], evento.fecha_inicio) && esNovatoAlumno(p[1], evento.fecha_inicio)) continue; // ⛔️
          parejas.push(p);
        }
      }

      parejas = parejas
        .sort(() => Math.random() - 0.5)
        .sort((a, b) =>
          ((a[0].guardias_actual||0)+(a[1].guardias_actual||0)) -
          ((b[0].guardias_actual||0)+(b[1].guardias_actual||0))
        );

      if (parejas.length > 0) {
        const [a1, a2] = parejas[0];
        try {
          await db.query('BEGIN');

          // Por si entre medias se creó una guardia
          const chk = await db.query(`SELECT 1 FROM guardias WHERE evento_id = $1`, [evento.evento_id]);
          if (chk.rowCount === 0) {
            await db.query(`
              INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
              VALUES ($1, $2, $3, $4, $5, NULL)
            `, [evento.evento_id, fechaStr, a1.id, a2.id, curso]);

            ocupados.add(a1.id);
            ocupados.add(a2.id);

            // Actual + Histórico
            await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1, guardias_hist = guardias_hist + 1 WHERE id = $1`, [a1.id]);
            await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1, guardias_hist = guardias_hist + 1 WHERE id = $1`, [a2.id]);
          }

          await db.query('COMMIT');
        } catch (insertErr) {
          console.error(`❌ Error insertando guardia para evento ${evento.evento_id}:`, insertErr.message);
          await db.query('ROLLBACK');
        }
      } else {
        console.log(`🚫 No hay parejas válidas para ${fechaStr}`);
      }
    }

    req.session.mensaje = 'Guardias generadas correctamente ✅';
    // Vuelve a la planilla manteniendo filtros
    const qs = new URLSearchParams({ desde: desde||'', hasta: hasta||'', grupo: grupo||'' }).toString();
    return res.redirect('/guardias' + (qs ? `?${qs}` : ''));

  } catch (err) {
    console.error('❌ Error al generar guardias:', err);
    return res.status(500).send(
      '<script>alert("Error al generar guardias múltiples. Revisa la consola del servidor para el detalle."); window.history.back();</script>'
    );
  }
});

/* =====
   PDF
   ===== */
router.post('/informe', async (req, res) => {
  const { desde, hasta, grupo } = req.body;
  const desdeISO = toISODate(desde);
  const hastaISO = toISODate(hasta);

  if (!desdeISO || !hastaISO || !grupo?.trim()) {
    return res.send('<script>alert("⚠️ Debes indicar un rango de fechas y un grupo."); window.history.back();</script>');
  }

  let sql = `
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
  `;
  const params = [desdeISO, hastaISO];
  if (grupo !== 'todos') { sql += ' AND gr.id = $3'; params.push(grupo); }

  try {
    const eventos = (await db.query(sql, params)).rows;
    if (!eventos.length) {
      return res.send('<script>alert("No hay eventos entre las fechas indicadas para ese grupo."); window.history.back();</script>');
    }
    const grupoNombre = (eventos[0]?.grupo || 'Todos los grupos').replace(/\s*\(.*\)/, '');
    generarPdfGuardias(res, { eventos, desde, hasta, grupoNombre });
  } catch (err) {
    console.error('❌ Error al generar informe:', err.message);
    res.status(500).send('Error al generar informe');
  }
});

/* =====
   AYUDA
   ===== */
router.get('/ayuda', (req, res) => {
  const locals = { title: 'Ayuda · Guardias', hero: false };
  // Intentamos ambos nombres por si el fichero tiene "s" o no
  req.app.render('ayudas_guardias', locals, (err, html) => {
    if (!err && html) return res.send(html);
    req.app.render('ayuda_guardias', locals, (err2, html2) => {
      if (!err2 && html2) return res.send(html2);
      res.status(404).send('No se encontró la plantilla de ayuda (ayudas_guardias.ejs / ayuda_guardias.ejs).');
    });
  });
});

module.exports = router;
