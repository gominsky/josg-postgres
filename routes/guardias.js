// routes/guardias.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

const { generarPdfGuardias } = require('../utils/pdfGuardias');
const { generarPdfCruzada }   = require('../utils/pdfCruzada');
const { toISODate }          = require('../utils/fechas');

/* =========================
   Helpers de curso/rollover
   ========================= */
const getCursoActual = () => {
  const hoy = new Date();
  const y   = hoy.getFullYear();
  return hoy.getMonth() >= 8 ? `${y}/${y+1}` : `${y-1}/${y}`;
};

async function ensureRolloverSiToca(db) {
  const cursoNuevo = getCursoActual();
  const { rows } = await db.query(
    `SELECT EXISTS(SELECT 1 FROM guardias WHERE curso = $1) AS hay_actual`,
    [cursoNuevo]
  );
  if (rows[0]?.hay_actual) return;
  await db.query(`UPDATE alumnos SET guardias_actual = 0 WHERE guardias_actual <> 0`);
}

/* ==========================================
   Detección dinámica columna de matriculación
   ========================================== */
let MAT_COL;
const MATRICULA_COL_CONFIG = (process.env.ALUMNOS_FECHA_MATRICULA_COL || '').trim();
let MAT_LOGGED = false;

function qIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function getMatriculaColumnName(dbOrClient) {
  if (MAT_COL !== undefined) return MAT_COL;

  if (MATRICULA_COL_CONFIG) {
    const { rows } = await dbOrClient.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='alumnos' AND column_name=$1`,
      [MATRICULA_COL_CONFIG]
    );
    if (rows.length) {
      MAT_COL = MATRICULA_COL_CONFIG;
      console.log(`ℹ️ Columna de matrícula (config): ${MAT_COL}`);
      return MAT_COL;
    }
    console.warn(`⚠️ ALUMNOS_FECHA_MATRICULA_COL="${MATRICULA_COL_CONFIG}" no existe. Autodetectando…`);
  }

  const candidatos = [
    'fecha_matriculacion','fecha_matricula','fecha_alta',
    'matricula','f_matricula','fecha_inscripcion',
    'alta','fecha_ingreso','ingreso'
  ];
  const { rows } = await dbOrClient.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='alumnos'
        AND column_name = ANY($1)
      ORDER BY array_position($1, column_name) LIMIT 1`,
    [candidatos]
  );
  MAT_COL = rows[0]?.column_name || null;
  if (MAT_COL) {
    console.log(`ℹ️ Columna de matrícula autodetectada: ${MAT_COL}`);
  } else if (!MAT_LOGGED) {
    console.warn('⚠️ No se encontró columna de matrícula; regla novatos desactivada.');
    MAT_LOGGED = true;
  }
  return MAT_COL;
}

/* ==============
   Helper de QS
   ============== */
function buildQs({ desde, hasta, grupo } = {}) {
  const p = [];
  if (desde) p.push(`desde=${encodeURIComponent(desde)}`);
  if (hasta) p.push(`hasta=${encodeURIComponent(hasta)}`);
  if (grupo) p.push(`grupo=${encodeURIComponent(grupo)}`);
  return p.length ? `?${p.join('&')}` : '';
}

/* ==================
   Reglas de "novato"
   ================== */
function corteDelCurso(fechaRef) {
  const d = new Date(fechaRef);
  const baseYear = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(baseYear, 0, 1);
}

function esNovatoAlumno(alumno, fechaRef) {
  if (!alumno || !('fecha_matricula' in alumno) || !alumno.fecha_matricula) return false;
  const corte = corteDelCurso(fechaRef);
  const mat   = new Date(alumno.fecha_matricula);
  const ga    = Number(alumno.guardias_actual || 0);
  return mat >= corte && ga < 2;
}

const EMERGENCIA_TODOS_NOVATOS =
  (process.env.GUARDIAS_EMERGENCIA_TODOS_NOVATOS ?? '1') === '1';

/* =========================================================
   Helper: construye la mejor lista de N músicos disponibles
   respetando la regla novato+novato y la carga equitativa.
   ========================================================= */
function seleccionarMusicos(disponibles, n, fechaRef) {
  if (disponibles.length < n) return { musicos: [], emergencia: false };

  // Ordena por carga (ascendente) + algo de aleatoriedad para el empate
  const ordenados = [...disponibles]
    .sort(() => Math.random() - 0.5)
    .sort((a, b) => (a.guardias_actual || 0) - (b.guardias_actual || 0));

  // Para n=2 aplicamos la regla novato+novato
  if (n === 2) {
    // Intentar pareja válida (no novato+novato)
    for (let i = 0; i < ordenados.length; i++) {
      for (let j = i + 1; j < ordenados.length; j++) {
        const [a, b] = [ordenados[i], ordenados[j]];
        if (esNovatoAlumno(a, fechaRef) && esNovatoAlumno(b, fechaRef)) continue;
        return { musicos: [a, b], emergencia: false };
      }
    }
    // Emergencia: todos novatos
    if (EMERGENCIA_TODOS_NOVATOS && ordenados.length >= 2 &&
        ordenados.every(a => esNovatoAlumno(a, fechaRef))) {
      return { musicos: [ordenados[0], ordenados[1]], emergencia: true };
    }
    return { musicos: [], emergencia: false };
  }

  // Para n != 2: tomamos los N de menor carga,
  // intentando que no sean TODOS novatos si hay alternativa
  const candidatos = ordenados.slice(0, n);
  const todosNovatos = candidatos.every(a => esNovatoAlumno(a, fechaRef));
  if (todosNovatos && n >= 2) {
    // Intentar sustituir al menos uno por un no-novato
    const noNovatos = ordenados.filter(a => !esNovatoAlumno(a, fechaRef));
    if (noNovatos.length > 0) {
      // Reemplaza el último novato (más cargado del candidato) por el primer no-novato
      const mezcla = candidatos.slice(0, n - 1).concat([noNovatos[0]]);
      return { musicos: mezcla, emergencia: false };
    }
    // Si no hay no-novatos → emergencia
    return {
      musicos: candidatos,
      emergencia: EMERGENCIA_TODOS_NOVATOS
    };
  }

  return { musicos: candidatos, emergencia: false };
}

/* =========================================================
   Helper: alumnos activos del grupo con columna matrícula
   ========================================================= */
async function alumnosDelGrupo(dbOrClient, grupo_id) {
  const matCol = await getMatriculaColumnName(dbOrClient);
  const cols = `a.id, a.nombre, a.apellidos, a.guardias_actual${
    matCol ? `, a.${qIdent(matCol)} AS fecha_matricula` : ''
  }`;
  const { rows } = await dbOrClient.query(`
    SELECT ${cols}
    FROM alumnos a
    JOIN alumno_grupo ag ON ag.alumno_id = a.id
    WHERE ag.grupo_id = $1 AND a.activo = TRUE
    ORDER BY a.guardias_actual ASC, a.apellidos ASC
  `, [grupo_id]);
  return rows;
}

/* =========================================================
   Helper: set de alumnos ocupados en una fecha (excluyendo
   opcionalmente una guardia concreta para edición)
   ========================================================= */
async function ocupadosEnFecha(dbOrClient, fechaStr, excluirGuardiaId = null) {
  const { rows } = await dbOrClient.query(`
    SELECT g.alumno_id_1, g.alumno_id_2, g.alumno_ids
    FROM guardias g
    JOIN eventos e ON e.id = g.evento_id
    WHERE DATE(e.fecha_inicio) = DATE($1)
    ${excluirGuardiaId ? 'AND g.id <> $2' : ''}
  `, excluirGuardiaId ? [fechaStr, excluirGuardiaId] : [fechaStr]);

  const set = new Set();
  rows.forEach(g => {
    // Soporte tanto para columna nueva alumno_ids (array) como legado id_1/id_2
    if (Array.isArray(g.alumno_ids)) {
      g.alumno_ids.forEach(id => { if (id) set.add(id); });
    }
    if (g.alumno_id_1) set.add(g.alumno_id_1);
    if (g.alumno_id_2) set.add(g.alumno_id_2);
  });
  return set;
}

/* ==========================================================================
   NOTA sobre esquema: el sistema original usa columnas alumno_id_1 / alumno_id_2.
   Las guardias de actividades pueden tener N músicos; se usa alumno_ids (int[]).
   La lógica es retrocompatible: si alumno_ids es null → usa id_1/id_2.
   ========================================================================== */

/* ==================
   GET /guardias
   ================== */
router.get('/', async (req, res) => {
  await ensureRolloverSiToca(db);
  try {
    const { desde, hasta, grupo } = req.query;

    const { rows: grupos }       = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const { rows: actividades }  = await db.query(
      'SELECT id, tipo, descripcion FROM actividades_complementarias ORDER BY tipo'
    ).catch(() => ({ rows: [] })); // graceful si tabla no existe aún

    res.render('guardias_lista', {
      title: 'Guardias',
      hero: false,
      grupos,
      actividades,
      grupo: grupo || '',
      desde: desde || '',
      hasta: hasta || '',
      mensaje: req.session.mensaje,
      error:   req.session.error,
    });
    delete req.session.mensaje;
    delete req.session.error;
  } catch (e) {
    console.error('❌ GET /guardias:', e);
    res.status(500).send('Error al cargar guardias');
  }
});

/* ==================
   GET /guardias/mostrar
   ================== */
router.get('/mostrar', async (req, res) => {
  await ensureRolloverSiToca(db);
  try {
    let { desde = '', hasta = '', grupo = '' } = req.query;
    const params = [];
    const where  = [];

    if (desde) { params.push(desde); where.push(`e.fecha_inicio::date >= $${params.length}::date`); }
    if (hasta) { params.push(hasta); where.push(`e.fecha_inicio::date <= $${params.length}::date`); }
    if (grupo && grupo !== 'todos') { params.push(grupo); where.push(`e.grupo_id = $${params.length}`); }

    const sql = `
      SELECT
        e.id                  AS evento_id,
        e.titulo              AS evento,
        e.fecha_inicio,
        e.fecha_fin,
        gr.nombre             AS grupo,
        gu.id                 AS guardia_id,
        gu.tipo_guardia,
        gu.tipo_actividad,
        gu.num_musicos,
        gu.alumno_id_1,
        gu.alumno_id_2,
        gu.alumno_ids,
        gu.notas,
        COALESCE(a1.apellidos || ', ' || a1.nombre, '-') AS guardia1,
        COALESCE(a2.apellidos || ', ' || a2.nombre, '-') AS guardia2
      FROM eventos e
      LEFT JOIN grupos    gr ON gr.id = e.grupo_id
      LEFT JOIN guardias  gu ON gu.evento_id = e.id
      LEFT JOIN alumnos   a1 ON a1.id = gu.alumno_id_1
      LEFT JOIN alumnos   a2 ON a2.id = gu.alumno_id_2
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.fecha_inicio ASC
      LIMIT 500
    `;

    const { rows: guardias } = await db.query(sql, params);
    const { rows: grupos }   = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre ASC');

    // Para guardias con alumno_ids (actividad), recuperamos los nombres
    const idsExtra = [];
    guardias.forEach(g => {
      if (Array.isArray(g.alumno_ids)) {
        g.alumno_ids.forEach(id => { if (id) idsExtra.push(id); });
      }
    });
    let nombresExtra = {};
    if (idsExtra.length) {
      const { rows: extra } = await db.query(
        `SELECT id, apellidos || ', ' || nombre AS nombre_completo FROM alumnos WHERE id = ANY($1)`,
        [idsExtra]
      );
      extra.forEach(r => { nombresExtra[r.id] = r.nombre_completo; });
    }

    res.render('guardias_mostrar', {
      title: 'Planilla de guardias',
      hero: false,
      guardias, grupos, nombresExtra,
      desde, hasta, grupo,
      mensaje: req.session.mensaje,
      error:   req.session.error,
    });
    delete req.session.mensaje;
    delete req.session.error;

  } catch (e) {
    console.error('❌ GET /guardias/mostrar:', e);
    res.render('guardias_mostrar', {
      title: 'Planilla de guardias', hero: false,
      guardias: [], grupos: [], nombresExtra: {},
      desde: '', hasta: '', grupo: ''
    });
  }
});

/* ===========================
   GET /guardias/evento/:id
   =========================== */
router.get('/evento/:eventoId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM guardias WHERE evento_id = $1',
      [req.params.eventoId]
    );
    if (!rows.length) return res.status(404).json({ mensaje: 'No se encontraron guardias.' });
    res.json(rows);
  } catch (e) {
    console.error('Error al obtener guardias:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

/* =============================================================
   POST /guardias/generar  (guardia normal — pareja 2 músicos)
   ============================================================= */
router.post('/generar', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { evento_id, desde, hasta } = req.body;
  const curso = getCursoActual();
  const client = await db.connect();
  let tx = false;

  try {
    const { rows: [evento] } = await client.query(
      `SELECT fecha_inicio, grupo_id FROM eventos WHERE id = $1`, [evento_id]
    );
    if (!evento) return res.status(404).send('Evento no encontrado');

    const fechaStr = toISODate(evento.fecha_inicio);
    const alumnos  = await alumnosDelGrupo(client, evento.grupo_id);
    const ocupados = await ocupadosEnFecha(client, fechaStr);
    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    if (!disponibles.length) {
      req.session.error = 'Sin alumnos disponibles para esta fecha';
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));
    }

    const { musicos, emergencia } = seleccionarMusicos(disponibles, 2, evento.fecha_inicio);

    if (!musicos.length) {
      req.session.error = 'No hay parejas válidas para esta guardia';
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));
    }

    await client.query('BEGIN'); tx = true;

    const dup = await client.query(`SELECT 1 FROM guardias WHERE evento_id = $1`, [evento_id]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK'); tx = false;
      req.session.error = 'Este evento ya tiene guardia asignada.';
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));
    }

    const [a1, a2] = musicos;
    await client.query(`
      INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, tipo_guardia, notas)
      VALUES ($1, $2, $3, $4, $5, 'normal', NULL)
    `, [evento_id, fechaStr, a1.id, a2.id, curso]);

    for (const a of musicos) {
      await client.query(`
        UPDATE alumnos SET guardias_actual = guardias_actual + 1,
                           guardias_hist   = guardias_hist   + 1
        WHERE id = $1
      `, [a.id]);
    }

    await client.query('COMMIT'); tx = false;

    req.session.mensaje = emergencia
      ? 'Guardia asignada ✅ (excepción: todos novatos)'
      : 'Guardia asignada ✅';

    return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));

  } catch (e) {
    if (tx) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('❌ POST /guardias/generar:', e);
    res.status(500).send('Error al generar guardia');
  } finally {
    client.release();
  }
});

/* =============================================================
   POST /guardias/generar-actividad
   Guardia de actividad complementaria: N músicos, tipo montaje/desmontaje/ambas
   ============================================================= */
router.post('/generar-actividad', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { evento_id, actividad_id, tipo_actividad, num_musicos, desde, hasta } = req.body;
  const curso  = getCursoActual();
  const n      = Math.max(1, parseInt(num_musicos, 10) || 2);
  const client = await db.connect();
  let tx = false;

  try {
    const { rows: [evento] } = await client.query(
      `SELECT e.fecha_inicio, e.grupo_id, ac.tipo AS actividad_tipo
       FROM eventos e
       LEFT JOIN actividades_complementarias ac ON ac.id = $2
       WHERE e.id = $1`,
      [evento_id, actividad_id || null]
    );
    if (!evento) return res.status(404).send('Evento no encontrado');

    const fechaStr    = toISODate(evento.fecha_inicio);
    const alumnos     = await alumnosDelGrupo(client, evento.grupo_id);
    const ocupados    = await ocupadosEnFecha(client, fechaStr);
    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    if (disponibles.length < n) {
      req.session.error = `No hay suficientes músicos disponibles (necesarios: ${n}, disponibles: ${disponibles.length})`;
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));
    }

    const { musicos, emergencia } = seleccionarMusicos(disponibles, n, evento.fecha_inicio);

    if (!musicos.length) {
      req.session.error = 'No se pudo formar el grupo de guardia con las restricciones actuales';
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));
    }

    await client.query('BEGIN'); tx = true;

    // Usamos alumno_id_1/id_2 para los dos primeros (compatibilidad) y alumno_ids para todos
    const alumnoIds = musicos.map(a => a.id);
    await client.query(`
      INSERT INTO guardias
        (evento_id, fecha, alumno_id_1, alumno_id_2, alumno_ids, curso,
         tipo_guardia, tipo_actividad, actividad_id, num_musicos, notas)
      VALUES ($1,$2,$3,$4,$5,$6,'actividad',$7,$8,$9,NULL)
    `, [
      evento_id,
      fechaStr,
      alumnoIds[0] || null,
      alumnoIds[1] || null,
      alumnoIds,
      curso,
      tipo_actividad,
      actividad_id || null,
      n
    ]);

    for (const a of musicos) {
      await client.query(`
        UPDATE alumnos SET guardias_actual = guardias_actual + 1,
                           guardias_hist   = guardias_hist   + 1
        WHERE id = $1
      `, [a.id]);
    }

    await client.query('COMMIT'); tx = false;

    req.session.mensaje = emergencia
      ? `Guardia de actividad asignada ✅ (${tipo_actividad}, ${n} músicos, excepción: todos novatos)`
      : `Guardia de actividad asignada ✅ (${tipo_actividad}, ${n} músicos)`;

    return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta }));

  } catch (e) {
    if (tx) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('❌ POST /guardias/generar-actividad:', e);
    res.status(500).send('Error al generar guardia de actividad');
  } finally {
    client.release();
  }
});

/* =============================================================
   GET /guardias/editar/:id
   ============================================================= */
router.get('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { desde, hasta, grupo } = req.query;

  try {
    const { rows: [guardia] } = await db.query(`
      SELECT g.*, e.titulo AS evento, e.grupo_id, e.fecha_inicio
      FROM guardias g
      JOIN eventos e ON g.evento_id = e.id
      WHERE g.id = $1
    `, [id]);
    if (!guardia) return res.status(404).send('Guardia no encontrada');

    const fechaStr = toISODate(guardia.fecha_inicio);
    const alumnos  = await alumnosDelGrupo(db, guardia.grupo_id);
    const ocupados = await ocupadosEnFecha(db, fechaStr, id);

    // Los alumnos actuales de la guardia siempre están disponibles para editar
    const asignadosActuales = new Set(
      [guardia.alumno_id_1, guardia.alumno_id_2,
       ...(Array.isArray(guardia.alumno_ids) ? guardia.alumno_ids : [])
      ].filter(Boolean)
    );

    const disponibles = alumnos.map(a => ({
      ...a,
      ocupado: ocupados.has(a.id) && !asignadosActuales.has(a.id)
    }));

    // Recuperar actividades para el select de tipo
    const { rows: actividades } = await db.query(
      'SELECT id, tipo, descripcion FROM actividades_complementarias ORDER BY tipo'
    ).catch(() => ({ rows: [] }));

    // Nombres de todos los músicos asignados actualmente
    let alumnosAsignados = [];
    if (guardia.tipo_guardia === 'actividad' && Array.isArray(guardia.alumno_ids) && guardia.alumno_ids.length > 0) {
      const { rows } = await db.query(
        `SELECT id, apellidos || ', ' || nombre AS nombre_completo, guardias_actual
         FROM alumnos WHERE id = ANY($1) ORDER BY apellidos`,
        [guardia.alumno_ids]
      );
      alumnosAsignados = rows;
    }

    res.render('guardias_editar', {
      guardia,
      eventoTitulo: guardia.evento,
      disponibles: disponibles.filter(a => !a.ocupado),
      ocupados:    disponibles.filter(a => a.ocupado),
      alumnosAsignados,
      actividades,
      desde, hasta, grupo
    });

  } catch (e) {
    console.error('❌ GET /guardias/editar:', e);
    res.status(500).send('Error al cargar datos de la guardia');
  }
});

/* =============================================================
   POST /guardias/guardar
   ============================================================= */
router.post('/guardar', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { id, alumno_id_1, alumno_id_2, alumno_ids_multi,
          notas, desde, hasta, grupo } = req.body;

  const client = await db.connect();
  let tx = false;

  try {
    await client.query('BEGIN'); tx = true;

    const { rows: [meta] } = await client.query(
      `SELECT DATE(e.fecha_inicio) AS dia, g.tipo_guardia, g.alumno_id_1, g.alumno_id_2, g.alumno_ids
       FROM guardias g JOIN eventos e ON e.id = g.evento_id
       WHERE g.id = $1`, [id]
    );
    if (!meta) {
      await client.query('ROLLBACK'); tx = false;
      return res.status(404).send('Guardia no encontrada');
    }

    const dia = meta.dia;

    // Determinar conjuntos anterior/nuevo según tipo
    const prevIds = meta.tipo_guardia === 'actividad' && Array.isArray(meta.alumno_ids)
      ? meta.alumno_ids.filter(Boolean)
      : [meta.alumno_id_1, meta.alumno_id_2].filter(Boolean);

    let newIds;
    if (meta.tipo_guardia === 'actividad') {
      // alumno_ids_multi viene como array de strings (checkboxes) o string simple
      const raw = Array.isArray(alumno_ids_multi)
        ? alumno_ids_multi
        : (alumno_ids_multi ? [alumno_ids_multi] : []);
      newIds = [...new Set(raw.map(Number).filter(Boolean))];
    } else {
      const n1 = alumno_id_1 ? Number(alumno_id_1) : null;
      const n2 = alumno_id_2 ? Number(alumno_id_2) : null;
      newIds = [n1, n2].filter(Boolean);

      // Verificar ocupación ese día (sólo para guardias normales)
      for (const nId of newIds) {
        const { rowCount } = await client.query(`
          SELECT 1 FROM guardias g
          JOIN eventos e ON e.id = g.evento_id
          WHERE DATE(e.fecha_inicio) = $1 AND g.id <> $2
            AND $3 = ANY(ARRAY[g.alumno_id_1, g.alumno_id_2])
        `, [dia, id, nId]);
        if (rowCount > 0) {
          await client.query('ROLLBACK'); tx = false;
          req.session.mensaje = `⚠️ El alumno ya tiene guardia ese día.`;
          return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));
        }
      }

      // Regla novato+novato en edición
      if (newIds.length === 2) {
        const matCol = await getMatriculaColumnName(client);
        let selectCols = 'id, guardias_actual';
        if (matCol) selectCols += `, ${qIdent(matCol)} AS fecha_matricula`;
        const { rows: novRes } = await client.query(
          `SELECT ${selectCols} FROM alumnos WHERE id = ANY($1::int[])`, [newIds]
        );
        const mapa = Object.fromEntries(novRes.map(r => [r.id, r]));
        if (esNovatoAlumno(mapa[newIds[0]], dia) && esNovatoAlumno(mapa[newIds[1]], dia)) {
          await client.query('ROLLBACK'); tx = false;
          req.session.mensaje = '⚠️ No se pueden asignar dos novatos en la misma guardia.';
          return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));
        }
      }
    }

    // Actualizar guardia
    if (meta.tipo_guardia === 'actividad') {
      await client.query(`
        UPDATE guardias
           SET alumno_ids  = $1,
               alumno_id_1 = $2,
               alumno_id_2 = $3,
               notas       = $4
         WHERE id = $5
      `, [newIds, newIds[0] || null, newIds[1] || null, notas || '', id]);
    } else {
      await client.query(`
        UPDATE guardias
           SET alumno_id_1 = $1, alumno_id_2 = $2, notas = $3
         WHERE id = $4
      `, [newIds[0] || null, newIds[1] || null, notas || '', id]);
    }

    // Ajuste de contadores
    const prevSet = new Set(prevIds);
    const newSet  = new Set(newIds);
    const removed = [...prevSet].filter(x => !newSet.has(x));
    const added   = [...newSet].filter(x => !prevSet.has(x));

    for (const uid of removed) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0),
               guardias_hist   = GREATEST(guardias_hist   - 1, 0)
         WHERE id = $1
      `, [uid]);
    }
    for (const uid of added) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = guardias_actual + 1,
               guardias_hist   = guardias_hist   + 1
         WHERE id = $1
      `, [uid]);
    }

    await client.query('COMMIT'); tx = false;

    res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));

  } catch (e) {
    if (tx) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('❌ POST /guardias/guardar:', e);
    res.status(500).send('Error al guardar guardia');
  } finally {
    client.release();
  }
});

/* =============================================================
   POST /guardias/eliminar/:id
   ============================================================= */
router.post('/eliminar/:id', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { id } = req.params;
  const { desde, hasta, grupo } = req.query;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows, rowCount } = await client.query(
      `SELECT alumno_id_1, alumno_id_2, alumno_ids FROM guardias WHERE id = $1`, [id]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      req.session.error = 'No se encontró la guardia';
      return res.redirect('/guardias/mostrar');
    }

    const g = rows[0];
    const idsAfectados = Array.isArray(g.alumno_ids) && g.alumno_ids.length
      ? g.alumno_ids.filter(Boolean)
      : [g.alumno_id_1, g.alumno_id_2].filter(Boolean);

    await client.query('DELETE FROM guardias WHERE id = $1', [id]);

    for (const uid of idsAfectados) {
      await client.query(`
        UPDATE alumnos
           SET guardias_actual = GREATEST(guardias_actual - 1, 0),
               guardias_hist   = GREATEST(guardias_hist   - 1, 0)
         WHERE id = $1
      `, [uid]);
    }

    await client.query('COMMIT');

    req.session.mensaje = 'Guardia eliminada ✅';
    res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ POST /guardias/eliminar:', e);
    req.session.error = 'Error al eliminar la guardia';
    res.redirect('/guardias/mostrar');
  } finally {
    client.release();
  }
});

/* =============================================================
   POST /guardias/generar-multiples
   ============================================================= */
router.post('/generar-multiples', async (req, res) => {
  await ensureRolloverSiToca(db);
  const { desde, hasta, grupo } = req.body;
  const desdeISO = toISODate(desde);
  const hastaISO = toISODate(hasta);
  const curso    = getCursoActual();

  if (!desdeISO || !hastaISO) {
    return res.send('<script>alert("Indica un rango de fechas válido."); window.history.back();</script>');
  }

  try {
    let sqlEventos = `
      SELECT e.id AS evento_id, e.fecha_inicio, e.grupo_id
      FROM eventos e
      LEFT JOIN guardias g ON g.evento_id = e.id AND g.tipo_guardia = 'normal'
      WHERE e.fecha_inicio BETWEEN $1 AND $2 AND g.id IS NULL
    `;
    const paramsEventos = [desdeISO, hastaISO];
    if (grupo) { sqlEventos += ' AND e.grupo_id = $3'; paramsEventos.push(grupo); }
    sqlEventos += ' ORDER BY e.fecha_inicio ASC';

    const { rows: eventos } = await db.query(sqlEventos, paramsEventos);
    if (!eventos.length) {
      req.session.mensaje = 'No hay eventos sin guardia normal en ese rango.';
      return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));
    }

    const ocupadosPorFecha = {};
    let emergencias = 0;
    let asignadas   = 0;

    for (const evento of eventos) {
      if (!evento.fecha_inicio) continue;
      const fechaStr = toISODate(evento.fecha_inicio);

      if (!ocupadosPorFecha[fechaStr]) {
        ocupadosPorFecha[fechaStr] = await ocupadosEnFecha(db, fechaStr);
      }
      const ocupados = ocupadosPorFecha[fechaStr];

      const alumnos     = await alumnosDelGrupo(db, evento.grupo_id);
      const disponibles = alumnos.filter(a => !ocupados.has(a.id));
      if (!disponibles.length) continue;

      const { musicos, emergencia } = seleccionarMusicos(disponibles, 2, evento.fecha_inicio);
      if (!musicos.length) {
        console.log(`🚫 Sin parejas válidas para ${fechaStr}`);
        continue;
      }

      const [a1, a2] = musicos;
      const c = await db.connect();
      let tx = false;
      try {
        await c.query('BEGIN'); tx = true;
        const chk = await c.query(`SELECT 1 FROM guardias WHERE evento_id = $1 AND tipo_guardia='normal'`, [evento.evento_id]);
        if (chk.rowCount === 0) {
          await c.query(`
            INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, tipo_guardia, notas)
            VALUES ($1,$2,$3,$4,$5,'normal',NULL)
          `, [evento.evento_id, fechaStr, a1.id, a2.id, curso]);

          ocupados.add(a1.id);
          ocupados.add(a2.id);
          // Actualizar carga en memoria para el siguiente evento del mismo día
          [a1, a2].forEach(a => { a.guardias_actual = (a.guardias_actual || 0) + 1; });

          await c.query(`UPDATE alumnos SET guardias_actual=guardias_actual+1, guardias_hist=guardias_hist+1 WHERE id=$1`, [a1.id]);
          await c.query(`UPDATE alumnos SET guardias_actual=guardias_actual+1, guardias_hist=guardias_hist+1 WHERE id=$1`, [a2.id]);

          asignadas++;
          if (emergencia) emergencias++;
        }
        await c.query('COMMIT'); tx = false;
      } catch (e) {
        if (tx) { try { await c.query('ROLLBACK'); } catch {} }
        console.error(`❌ Error evento ${evento.evento_id}:`, e.message);
      } finally {
        c.release();
      }
    }

    req.session.mensaje = `${asignadas} guardia(s) asignada(s) ✅` +
      (emergencias ? ` (${emergencias} con excepción: todos novatos)` : '');
    return res.redirect('/guardias/mostrar' + buildQs({ desde, hasta, grupo }));

  } catch (e) {
    console.error('❌ POST /guardias/generar-multiples:', e);
    return res.status(500).send('<script>alert("Error al generar guardias múltiples."); window.history.back();</script>');
  }
});

/* ============
   PDF — común
   ============ */
async function handleGuardiasPdf(req, res) {
  try {
    const isGet = req.method === 'GET';
    const desde = isGet ? req.query.desde : req.body.desde;
    const hasta = isGet ? req.query.hasta : req.body.hasta;
    const grupo = isGet ? (req.query.grupo || '') : (req.body.grupo || '');

    const desdeISO = toISODate(desde);
    const hastaISO = toISODate(hasta);

    if (!desdeISO || !hastaISO) {
      if (isGet) return res.status(400).send('Faltan fechas (usa YYYY-MM-DD)');
      return res.send('<script>alert("⚠️ Debes indicar un rango de fechas."); window.history.back();</script>');
    }

    const filtraGrupo = grupo && grupo.trim() && grupo !== 'todos';
    let sql = `
      SELECT
        e.fecha_inicio AS fecha,
        e.titulo AS evento,
        gr.nombre AS grupo,
        gu.tipo_guardia,
        gu.tipo_actividad,
        gu.num_musicos,
        a1.nombre || ' ' || a1.apellidos AS guardia1,
        a2.nombre || ' ' || a2.apellidos AS guardia2,
        gu.alumno_ids
      FROM eventos e
      JOIN guardias gu ON gu.evento_id = e.id
      LEFT JOIN alumnos a1 ON gu.alumno_id_1 = a1.id
      LEFT JOIN alumnos a2 ON gu.alumno_id_2 = a2.id
      LEFT JOIN grupos  gr ON e.grupo_id = gr.id
      WHERE DATE(e.fecha_inicio) BETWEEN $1 AND $2
    `;
    const params = [desdeISO, hastaISO];
    if (filtraGrupo) { sql += ' AND gr.id = $3'; params.push(grupo); }
    sql += ' ORDER BY e.fecha_inicio ASC';

    const { rows: eventos } = await db.query(sql, params);
    if (!eventos.length) {
      const msg = 'No hay eventos entre las fechas indicadas' + (filtraGrupo ? ' para ese grupo' : '') + '.';
      if (isGet) return res.status(404).send(msg);
      return res.send(`<script>alert("${msg}"); window.history.back();</script>`);
    }

    const grupoNombre = filtraGrupo ? (eventos[0]?.grupo || 'Grupo') : 'Todos los grupos';
    generarPdfGuardias(res, { eventos, desde, hasta, grupoNombre });

  } catch (e) {
    console.error('❌ PDF guardias:', e.message);
    res.status(500).send('Error al generar informe');
  }
}

router.post('/informe',     handleGuardiasPdf);
router.get('/planilla.pdf', handleGuardiasPdf);

/* ============================================================
   GET /guardias/cruzada  — tabla referencias cruzadas músicos × eventos
   ============================================================ */
router.get('/cruzada', async (req, res) => {
  try {
    const { desde = '', hasta = '', grupo = '' } = req.query;
    const { rows: grupos } = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');

    if (!desde || !hasta) {
      return res.render('guardias_cruzada', {
        title: 'Tabla de asistencias', hero: false,
        grupos, desde, hasta, grupo,
        eventos: [], alumnos: [], matriz: {}
      });
    }

    // Eventos con guardia en el rango
    const params = [desde, hasta];
    const whereGrupo = grupo ? `AND e.grupo_id = $${params.push(grupo)}` : '';

    const { rows: eventos } = await db.query(`
      SELECT DISTINCT e.id, e.titulo, e.fecha_inicio, gr.nombre AS grupo_nombre
      FROM eventos e
      JOIN guardias g ON g.evento_id = e.id
      LEFT JOIN grupos gr ON gr.id = e.grupo_id
      WHERE DATE(e.fecha_inicio) BETWEEN $1::date AND $2::date
      ${whereGrupo}
      ORDER BY e.fecha_inicio ASC
    `, params);

    if (!eventos.length) {
      return res.render('guardias_cruzada', {
        title: 'Tabla de asistencias', hero: false,
        grupos, desde, hasta, grupo,
        eventos: [], alumnos: [], matriz: {}
      });
    }

    const eventoIds = eventos.map(e => e.id);

    // Todas las guardias de esos eventos
    const { rows: guardias } = await db.query(`
      SELECT g.evento_id, g.tipo_guardia, g.tipo_actividad,
             g.alumno_id_1, g.alumno_id_2, g.alumno_ids
      FROM guardias g
      WHERE g.evento_id = ANY($1)
    `, [eventoIds]);

    // Recopilar todos los alumno_ids afectados
    const alumnoIdsSet = new Set();
    guardias.forEach(g => {
      if (Array.isArray(g.alumno_ids)) g.alumno_ids.forEach(id => { if (id) alumnoIdsSet.add(id); });
      if (g.alumno_id_1) alumnoIdsSet.add(g.alumno_id_1);
      if (g.alumno_id_2) alumnoIdsSet.add(g.alumno_id_2);
    });

    if (!alumnoIdsSet.size) {
      return res.render('guardias_cruzada', {
        title: 'Tabla de asistencias', hero: false,
        grupos, desde, hasta, grupo,
        eventos, alumnos: [], matriz: {}
      });
    }

    // Datos de alumnos
    const { rows: alumnos } = await db.query(`
      SELECT id, nombre, apellidos
      FROM alumnos WHERE id = ANY($1)
      ORDER BY apellidos, nombre
    `, [[...alumnoIdsSet]]);

    // Construir matriz: matriz[alumno_id][evento_id] = { tipo, subtipo }
    const matriz = {};
    guardias.forEach(g => {
      const ids = Array.isArray(g.alumno_ids) && g.alumno_ids.length
        ? g.alumno_ids.filter(Boolean)
        : [g.alumno_id_1, g.alumno_id_2].filter(Boolean);

      ids.forEach(aid => {
        if (!matriz[aid]) matriz[aid] = {};
        matriz[aid][g.evento_id] = {
          tipo:    g.tipo_guardia || 'normal',
          subtipo: g.tipo_actividad || ''
        };
      });
    });

    res.render('guardias_cruzada', {
      title: 'Tabla de asistencias', hero: false,
      grupos, desde, hasta, grupo,
      eventos, alumnos, matriz
    });

  } catch (e) {
    console.error('❌ GET /guardias/cruzada:', e);
    res.status(500).send('Error al generar tabla de asistencias');
  }
});

/* ============================================================
   GET /guardias/eventos-rango  (AJAX — para el select de evento)
   Devuelve eventos del rango de fechas, opcionalmente por grupo.
   ============================================================ */
router.get('/eventos-rango', async (req, res) => {
  try {
    const { desde, hasta, grupo } = req.query;
    const desdeISO = toISODate(desde);
    const hastaISO = toISODate(hasta);

    if (!desdeISO || !hastaISO) {
      return res.json({ ok: false, eventos: [] });
    }

    const params = [desdeISO, hastaISO];
    const where  = ['e.fecha_inicio::date BETWEEN $1::date AND $2::date'];
    if (grupo && grupo !== 'todos' && grupo !== '') {
      params.push(grupo);
      where.push(`e.grupo_id = $${params.length}`);
    }

    const { rows } = await db.query(`
      SELECT
        e.id,
        e.titulo,
        DATE(e.fecha_inicio) AS fecha,
        gr.nombre AS grupo
      FROM eventos e
      LEFT JOIN grupos gr ON gr.id = e.grupo_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.fecha_inicio ASC
      LIMIT 200
    `, params);

    res.json({ ok: true, eventos: rows });
  } catch (e) {
    console.error('❌ GET /guardias/eventos-rango:', e);
    res.json({ ok: false, eventos: [] });
  }
});

/* ============================================================
   GET /guardias/cruzada-pdf — descarga PDF tabla referencias cruzadas
   ============================================================ */
router.get('/cruzada-pdf', async (req, res) => {
  try {
    const { desde = '', hasta = '', grupo = '' } = req.query;

    if (!desde || !hasta) {
      return res.status(400).send('Faltan parámetros desde/hasta');
    }

    const { rows: grupos } = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const grupoRow = grupo ? grupos.find(g => String(g.id) === String(grupo)) : null;
    const grupoNombre = grupoRow ? grupoRow.nombre : 'Todos los grupos';

    // Eventos con guardia en el rango
    const params = [desde, hasta];
    const whereGrupo = grupo ? `AND e.grupo_id = $${params.push(grupo)}` : '';

    const { rows: eventos } = await db.query(`
      SELECT DISTINCT e.id, e.titulo, e.fecha_inicio
      FROM eventos e
      JOIN guardias g ON g.evento_id = e.id
      LEFT JOIN grupos gr ON gr.id = e.grupo_id
      WHERE DATE(e.fecha_inicio) BETWEEN $1::date AND $2::date
      ${whereGrupo}
      ORDER BY e.fecha_inicio ASC
    `, params);

    if (!eventos.length) {
      return res.status(404).send('No hay guardias en ese periodo.');
    }

    const eventoIds = eventos.map(e => e.id);
    const { rows: guardias } = await db.query(`
      SELECT g.evento_id, g.tipo_guardia, g.tipo_actividad,
             g.alumno_id_1, g.alumno_id_2, g.alumno_ids
      FROM guardias g WHERE g.evento_id = ANY($1)
    `, [eventoIds]);

    const alumnoIdsSet = new Set();
    guardias.forEach(g => {
      if (Array.isArray(g.alumno_ids)) g.alumno_ids.forEach(id => { if (id) alumnoIdsSet.add(id); });
      if (g.alumno_id_1) alumnoIdsSet.add(g.alumno_id_1);
      if (g.alumno_id_2) alumnoIdsSet.add(g.alumno_id_2);
    });

    let alumnos = [];
    if (alumnoIdsSet.size) {
      const { rows } = await db.query(`
        SELECT id, nombre, apellidos FROM alumnos WHERE id = ANY($1) ORDER BY apellidos, nombre
      `, [[...alumnoIdsSet]]);
      alumnos = rows;
    }

    // Construir matriz
    const matriz = {};
    guardias.forEach(g => {
      const ids = Array.isArray(g.alumno_ids) && g.alumno_ids.length
        ? g.alumno_ids.filter(Boolean)
        : [g.alumno_id_1, g.alumno_id_2].filter(Boolean);
      ids.forEach(aid => {
        if (!matriz[aid]) matriz[aid] = {};
        matriz[aid][g.evento_id] = { tipo: g.tipo_guardia || 'normal', subtipo: g.tipo_actividad || '' };
      });
    });

    generarPdfCruzada(res, { alumnos, eventos, matriz, desde, hasta, grupoNombre });

  } catch (e) {
    console.error('❌ GET /guardias/cruzada-pdf:', e);
    res.status(500).send('Error al generar PDF');
  }
});
router.post('/cruzada-pdf', async (req, res) => {
  try {
    const { desde = '', hasta = '', grupo = '' } = req.body;

    if (!desde || !hasta) {
      return res.status(400).send('Faltan parámetros desde/hasta');
    }

    const { rows: grupos } = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const grupoRow = grupo ? grupos.find(g => String(g.id) === String(grupo)) : null;
    const grupoNombre = grupoRow ? grupoRow.nombre : 'Todos los grupos';

    // Eventos con guardia en el rango
    const params = [desde, hasta];
    const whereGrupo = grupo ? `AND e.grupo_id = $${params.push(grupo)}` : '';

    const { rows: eventos } = await db.query(`
      SELECT DISTINCT e.id, e.titulo, e.fecha_inicio
      FROM eventos e
      JOIN guardias g ON g.evento_id = e.id
      LEFT JOIN grupos gr ON gr.id = e.grupo_id
      WHERE DATE(e.fecha_inicio) BETWEEN $1::date AND $2::date
      ${whereGrupo}
      ORDER BY e.fecha_inicio ASC
    `, params);

    if (!eventos.length) {
      return res.status(404).send('No hay guardias en ese periodo.');
    }

    const eventoIds = eventos.map(e => e.id);
    const { rows: guardias } = await db.query(`
      SELECT g.evento_id, g.tipo_guardia, g.tipo_actividad,
             g.alumno_id_1, g.alumno_id_2, g.alumno_ids
      FROM guardias g WHERE g.evento_id = ANY($1)
    `, [eventoIds]);

    const alumnoIdsSet = new Set();
    guardias.forEach(g => {
      if (Array.isArray(g.alumno_ids)) g.alumno_ids.forEach(id => { if (id) alumnoIdsSet.add(id); });
      if (g.alumno_id_1) alumnoIdsSet.add(g.alumno_id_1);
      if (g.alumno_id_2) alumnoIdsSet.add(g.alumno_id_2);
    });

    let alumnos = [];
    if (alumnoIdsSet.size) {
      const { rows } = await db.query(`
        SELECT id, nombre, apellidos FROM alumnos WHERE id = ANY($1) ORDER BY apellidos, nombre
      `, [[...alumnoIdsSet]]);
      alumnos = rows;
    }

    // Construir matriz
    const matriz = {};
    guardias.forEach(g => {
      const ids = Array.isArray(g.alumno_ids) && g.alumno_ids.length
        ? g.alumno_ids.filter(Boolean)
        : [g.alumno_id_1, g.alumno_id_2].filter(Boolean);
      ids.forEach(aid => {
        if (!matriz[aid]) matriz[aid] = {};
        matriz[aid][g.evento_id] = { tipo: g.tipo_guardia || 'normal', subtipo: g.tipo_actividad || '' };
      });
    });

    generarPdfCruzada(res, { alumnos, eventos, matriz, desde, hasta, grupoNombre });

  } catch (e) {
    console.error('❌ GET /guardias/cruzada-pdf:', e);
    res.status(500).send('Error al generar PDF');
  }
});

/* ========
   Ayuda
   ======== */
router.get('/ayuda', (req, res) => {
  res.render('ayuda_guardias', { title: 'Ayuda · Guardias', hero: false });
});

module.exports = router;
