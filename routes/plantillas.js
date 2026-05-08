// routes/plantillas.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');

/* ---------- Helpers SQL para leer familias/instrumentos desde un evento ---------- */
const familiasSQL = `
  WITH asig AS (
    SELECT ea.alumno_id, ea.hora_inicio, ea.hora_fin, NULLIF(ea.instrumento,'') AS instrumento_key
    FROM evento_asignaciones ea
    WHERE ea.evento_id = $1
  ),
  fam_res AS (
    SELECT
      a.alumno_id,
      COALESCE(ins.familia, i1.familia) AS familia_final
    FROM asig a
    LEFT JOIN instrumentos ins ON ins.nombre = a.instrumento_key
    LEFT JOIN LATERAL (
      SELECT i.familia
      FROM alumno_instrumento ai
      JOIN instrumentos i ON i.id = ai.instrumento_id
      WHERE ai.alumno_id = a.alumno_id
      ORDER BY i.nombre
      LIMIT 1
    ) AS i1 ON TRUE
  )
  SELECT DISTINCT familia_final AS familia_key
  FROM fam_res
  WHERE NULLIF(BTRIM(familia_final), '') IS NOT NULL
  ORDER BY familia_key;
`;

const instrumentosSQL = `
  WITH base AS (
    SELECT
      a.id AS alumno_id, ea.instrumento,
      string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,
      bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro
    FROM evento_asignaciones ea
    JOIN alumnos a ON a.id = ea.alumno_id
    LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
    LEFT JOIN instrumentos ins      ON ins.id = ai.instrumento_id
    WHERE ea.evento_id = $1
    GROUP BY a.id, ea.instrumento
  ),
  gi AS (
    SELECT
      b.alumno_id,
      COUNT(DISTINCT ag2.grupo_id) AS grupos_count,
      bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)')      AS en_violin_i,
      bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*(ii|2))(\\b|\\s|$)') AS en_violin_ii
    FROM base b
    LEFT JOIN alumno_grupo ag2 ON ag2.alumno_id = b.alumno_id
    LEFT JOIN grupos g2        ON g2.id = ag2.grupo_id
    GROUP BY b.alumno_id
  ),
  etiquetado AS (
    SELECT
      b.*,
      CASE
        WHEN b.instrumento IS NOT NULL AND b.instrumento <> '' THEN b.instrumento
        WHEN b.has_violin_puro AND gi.grupos_count > 1 AND (gi.en_violin_i OR gi.en_violin_ii)
             THEN CASE WHEN gi.en_violin_i THEN 'Violín I' ELSE 'Violín II' END
        ELSE COALESCE(split_part(b.instrumentos, ', ', 1), '')
      END AS instrumento_key
    FROM base b
    LEFT JOIN gi ON gi.alumno_id = b.alumno_id
  )
  SELECT DISTINCT instrumento_key
  FROM etiquetado
  WHERE NULLIF(BTRIM(instrumento_key), '') IS NOT NULL
  ORDER BY instrumento_key;
`;

/* ---------- Crear plantilla desde evento ---------- */
async function crearPlantillaDesdeEvento(eventoId, { nombre, descripcion, familias_incluir: famBody, instrumentos_incluir: instBody, horas: horasBody, alumnos_ids, alumnos_extra }) {
  // Si el cliente envía alumnos_ids, derivar familias e instrumentos de esos alumnos en BD
  let familias_incluir, instrumentos_incluir;

  if (Array.isArray(alumnos_ids) && alumnos_ids.length) {
    // Familias de los alumnos visibles (solo normales, no extras)
    const famRes = await db.query(`
      SELECT DISTINCT COALESCE(ins.familia, '') AS familia_key
      FROM evento_asignaciones ea
      LEFT JOIN instrumentos ins ON ins.nombre = NULLIF(ea.instrumento,'')
      LEFT JOIN LATERAL (
        SELECT i.familia FROM alumno_instrumento ai
        JOIN instrumentos i ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = ea.alumno_id ORDER BY i.nombre LIMIT 1
      ) i1 ON ins.familia IS NULL
      WHERE ea.evento_id = $1 AND ea.alumno_id = ANY($2::int[])
      AND NULLIF(BTRIM(COALESCE(ins.familia, '')), '') IS NOT NULL
    `, [eventoId, alumnos_ids]);
    familias_incluir = famRes.rows.map(r => r.familia_key);

    const instRes = await db.query(`
      SELECT DISTINCT COALESCE(NULLIF(ea.instrumento,''),
        (SELECT ins2.nombre FROM alumno_instrumento ai2
         JOIN instrumentos ins2 ON ins2.id = ai2.instrumento_id
         WHERE ai2.alumno_id = ea.alumno_id ORDER BY ins2.nombre LIMIT 1)
      ) AS instrumento_key
      FROM evento_asignaciones ea
      WHERE ea.evento_id = $1 AND ea.alumno_id = ANY($2::int[])
      AND COALESCE(NULLIF(ea.instrumento,''), '') <> ''
    `, [eventoId, alumnos_ids]);
    instrumentos_incluir = instRes.rows.map(r => r.instrumento_key).filter(Boolean);

  } else if (Array.isArray(famBody) && famBody.length) {
    familias_incluir = famBody;
    instrumentos_incluir = Array.isArray(instBody) ? instBody : [];
  } else {
    const famRows = (await db.query(familiasSQL, [eventoId])).rows;
    familias_incluir = famRows.map(r => r.familia_key);
    const instRows = (await db.query(instrumentosSQL, [eventoId])).rows;
    instrumentos_incluir = instRows.map(r => r.instrumento_key);
  }

  // 2) Horas por FAMILIA (modo de (hora_inicio,hora_fin))
  const horasFamiliasSQL = `
    WITH asig AS (
      SELECT ea.alumno_id, ea.hora_inicio, ea.hora_fin, NULLIF(ea.instrumento,'') AS instrumento_key
      FROM evento_asignaciones ea
      WHERE ea.evento_id = $1
    ),
    fam_res AS (
      SELECT
        a.alumno_id,
        COALESCE(ins.familia, i1.familia) AS familia_final
      FROM asig a
      LEFT JOIN instrumentos ins ON ins.nombre = a.instrumento_key
      LEFT JOIN LATERAL (
        SELECT i.familia
        FROM alumno_instrumento ai
        JOIN instrumentos i ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = a.alumno_id
        ORDER BY i.nombre
        LIMIT 1
      ) AS i1 ON TRUE
    ),
    pair_counts AS (
      SELECT
        fr.familia_final,
        a.hora_inicio,
        a.hora_fin,
        COUNT(*) AS c
      FROM fam_res fr
      JOIN asig a ON a.alumno_id = fr.alumno_id
      WHERE NULLIF(BTRIM(fr.familia_final),'') IS NOT NULL
      GROUP BY fr.familia_final, a.hora_inicio, a.hora_fin
    ),
    best AS (
      SELECT DISTINCT ON (familia_final)
        familia_final, hora_inicio, hora_fin, c
      FROM pair_counts
      ORDER BY familia_final, c DESC, hora_inicio NULLS LAST, hora_fin NULLS LAST
    )
    SELECT
      familia_final AS key,
      CASE WHEN hora_inicio IS NULL THEN NULL ELSE to_char(hora_inicio,'HH24:MI') END AS inicio,
      CASE WHEN hora_fin    IS NULL THEN NULL ELSE to_char(hora_fin   ,'HH24:MI') END AS fin
    FROM best
    ORDER BY key;
  `;

  const horasInstrumentosSQL = `
    WITH base AS (
      SELECT
        a.id AS alumno_id, ea.instrumento,
        string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,
        bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro
      FROM evento_asignaciones ea
      JOIN alumnos a ON a.id = ea.alumno_id
      LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
      LEFT JOIN instrumentos ins      ON ins.id = ai.instrumento_id
      WHERE ea.evento_id = $1
      GROUP BY a.id, ea.instrumento
    ),
    gi AS (
      SELECT
        b.alumno_id,
        COUNT(DISTINCT ag2.grupo_id) AS grupos_count,
        bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)')      AS en_violin_i,
        bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*(ii|2))(\\b|\\s|$)') AS en_violin_ii
      FROM base b
      LEFT JOIN alumno_grupo ag2 ON ag2.alumno_id = b.alumno_id
      LEFT JOIN grupos g2        ON g2.id = ag2.grupo_id
      GROUP BY b.alumno_id
    ),
    etiquetado AS (
      SELECT
        b.alumno_id,
        CASE
          WHEN b.instrumento IS NOT NULL AND b.instrumento <> '' THEN b.instrumento
          WHEN b.has_violin_puro AND gi.grupos_count > 1 AND (gi.en_violin_i OR gi.en_violin_ii)
               THEN CASE WHEN gi.en_violin_i THEN 'Violín I' ELSE 'Violín II' END
          ELSE COALESCE(split_part(b.instrumentos, ', ', 1), '')
        END AS instrumento_key
      FROM base b
      LEFT JOIN gi ON gi.alumno_id = b.alumno_id
    ),
    pair_counts AS (
      SELECT
        e.instrumento_key,
        ea.hora_inicio,
        ea.hora_fin,
        COUNT(*) AS c
      FROM etiquetado e
      JOIN evento_asignaciones ea
        ON ea.evento_id = $1 AND ea.alumno_id = e.alumno_id
      WHERE NULLIF(BTRIM(e.instrumento_key),'') IS NOT NULL
      GROUP BY e.instrumento_key, ea.hora_inicio, ea.hora_fin
    ),
    best AS (
      SELECT DISTINCT ON (instrumento_key)
        instrumento_key, hora_inicio, hora_fin, c
      FROM pair_counts
      ORDER BY instrumento_key, c DESC, hora_inicio NULLS LAST, hora_fin NULLS LAST
    )
    SELECT
      instrumento_key AS key,
      CASE WHEN hora_inicio IS NULL THEN NULL ELSE to_char(hora_inicio,'HH24:MI') END AS inicio,
      CASE WHEN hora_fin    IS NULL THEN NULL ELSE to_char(hora_fin   ,'HH24:MI') END AS fin
    FROM best
    ORDER BY key;
  `;

  // Si el cliente envía horas del DOM, usarlas; si no, leer de BD
  let horas;
  if (horasBody && (Array.isArray(horasBody.familias) || Array.isArray(horasBody.instrumentos))) {
    horas = horasBody;
  } else {
    const horasFamilias = (await db.query(horasFamiliasSQL, [eventoId])).rows;
    const horasInstrumentos = (await db.query(horasInstrumentosSQL, [eventoId])).rows;
    horas = { familias: horasFamilias, instrumentos: horasInstrumentos };
  }

  // Añadir alumnos al JSON de horas para que el preview los use
  if (Array.isArray(alumnos_ids) && alumnos_ids.length) {
    horas.alumnos_ids = alumnos_ids;
  }
  if (Array.isArray(alumnos_extra) && alumnos_extra.length) {
    horas.alumnos_extra = alumnos_extra;
  }

  // 3) Inserción incluyendo horas
  const insSQL = `
    INSERT INTO plantillas_evento (nombre, descripcion, familias_incluir, instrumentos_incluir, horas)
    VALUES ($1, $2, $3::text[], $4::text[], $5::jsonb)
    RETURNING id
  `;
  const { rows } = await db.query(insSQL, [
    nombre.trim(),
    descripcion || null,
    familias_incluir,
    instrumentos_incluir,
    horas
  ]);

  return { id: rows[0].id, familias_incluir, instrumentos_incluir, horas };
}

/* ---------- POST /  (crear plantilla manual) ---------- */
router.post('/', async (req, res) => {
  try {
    const nombre = (req.body?.nombre || '').trim();
    let familias_incluir = Array.isArray(req.body?.familias_incluir) ? req.body.familias_incluir : [];
    let instrumentos_incluir = Array.isArray(req.body?.instrumentos_incluir) ? req.body.instrumentos_incluir : [];
    const descripcion = req.body?.descripcion || null;
    const horas = sanitizeHoras(req.body?.horas);

    if (!nombre) return res.status(400).json({ ok:false, error:'Nombre requerido' });

    const clean = arr => Array.from(new Set(arr.map(x => String(x||'').trim()).filter(Boolean)));
    familias_incluir = clean(familias_incluir);
    instrumentos_incluir = clean(instrumentos_incluir);

    if (!familias_incluir.length && !instrumentos_incluir.length) {
      return res.status(400).json({ ok:false, error:'Nada que guardar (familias/instrumentos vacíos)' });
    }

    const sql = `
      INSERT INTO plantillas_evento (nombre, descripcion, familias_incluir, instrumentos_incluir, horas)
      VALUES ($1, $2, $3::text[], $4::text[], $5::jsonb)
      RETURNING id
    `;
    const { rows } = await db.query(sql, [nombre, descripcion, familias_incluir, instrumentos_incluir, horas]);
    return res.json({ ok:true, id: rows[0].id, horas });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok:false, error:'Ya existe una plantilla con ese nombre' });
    }
    console.error('POST /plantillas error:', err);
    return res.status(500).json({ ok:false, error:'Error guardando la plantilla' });
  }
});

function sanitizeHoras(horas) {
  const isHHMM = v => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
  const fix = a => Array.isArray(a) ? a.map(x => ({
    key: String(x?.key || '').trim(),
    inicio: isHHMM(x?.inicio) ? x.inicio : null,
    fin:    isHHMM(x?.fin)    ? x.fin    : null
  })).filter(x => x.key) : [];
  if (!horas || typeof horas !== 'object') return { familias: [], instrumentos: [] };
  return { familias: fix(horas.familias), instrumentos: fix(horas.instrumentos) };
}

/* ---------- POST /from-event/:eventoId ---------- */
router.post('/from-event/:eventoId', async (req, res) => {
  const eventoId = Number(req.params.eventoId);
  const { nombre, descripcion, horas, alumnos_ids, alumnos_extra,
          familias_incluir, instrumentos_incluir } = req.body || {};
  if (!Number.isInteger(eventoId) || !nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  try {
    const out = await crearPlantillaDesdeEvento(eventoId, {
      nombre, descripcion, horas, alumnos_ids, alumnos_extra,
      familias_incluir_body: familias_incluir,
      instrumentos_incluir_body: instrumentos_incluir
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('POST /from-event/:eventoId', err);
    res.status(500).json({ error: 'Error creando plantilla' });
  }
});

/* ---------- GET /  (listar) ---------- */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, nombre, descripcion, horas,
             cardinality(familias_incluir)     AS familias,
             cardinality(instrumentos_incluir) AS instrumentos,
             created_at
      FROM plantillas_evento
      ORDER BY created_at DESC, id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /plantillas', err);
    res.status(500).json({ error: 'Error listando plantillas' });
  }
});

/* ---------- GET /:pid (detalle) ---------- */
router.get('/:pid', async (req, res) => {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rows } = await db.query(`SELECT * FROM plantillas_evento WHERE id=$1`, [pid]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /:pid', err);
    res.status(500).json({ error: 'Error' });
  }
});

/* ---------- GET /:pid/preview?eventoId=123 ---------- */
router.get('/:pid/preview', async (req, res) => {
  const pid = Number(req.params.pid);
  const eventoId = Number(req.query.eventoId);
  if (!Number.isInteger(pid) || !Number.isInteger(eventoId)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  try {
    const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
    const tpl = (await db.query(`SELECT * FROM plantillas_evento WHERE id=$1`, [pid])).rows[0];
    if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const sql = `
      WITH ev AS (
        SELECT e.id, e.grupo_id, left(e.fecha_inicio::text,10) AS f_iso
        FROM eventos e WHERE e.id = $1
      ),
      cand AS (
        SELECT a.id AS alumno_id, a.nombre, a.apellidos
        FROM ev
        JOIN alumno_grupo ag ON ag.grupo_id = ev.grupo_id
        JOIN alumnos a      ON a.id = ag.alumno_id
        WHERE COALESCE(a.activo, TRUE) IS TRUE
          AND (
            a.fecha_matriculacion IS NULL
            OR to_date(left(a.fecha_matriculacion::text,10),'YYYY-MM-DD') <= to_date(ev.f_iso,'YYYY-MM-DD')
          )
          AND (
            a.fecha_baja IS NULL
            OR to_date(left(a.fecha_baja::text,10),'YYYY-MM-DD') >= to_date(ev.f_iso,'YYYY-MM-DD')
          )
      ),
      res AS (
        SELECT
          c.alumno_id, c.nombre, c.apellidos,
          COALESCE(
            ea.instrumento,
            CASE
              WHEN base.has_violin_puro AND gi.grupos_count > 1 AND (gi.en_violin_i OR gi.en_violin_ii)
                THEN CASE WHEN gi.en_violin_i THEN 'Violín I' ELSE 'Violín II' END
              ELSE split_part(base.instrumentos, ', ', 1)
            END
          ) AS instrumento_key
        FROM cand c
        LEFT JOIN evento_asignaciones ea
               ON ea.evento_id = $1 AND ea.alumno_id = c.alumno_id
        LEFT JOIN LATERAL (
          SELECT
            string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,
            bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro
          FROM alumno_instrumento ai
          JOIN instrumentos ins ON ins.id = ai.instrumento_id
          WHERE ai.alumno_id = c.alumno_id
        ) base ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT ag2.grupo_id) AS grupos_count,
            bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)')      AS en_violin_i,
            bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*(ii|2))(\\b|\\s|$)') AS en_violin_ii
          FROM alumno_grupo ag2
          JOIN grupos g2 ON g2.id = ag2.grupo_id
          WHERE ag2.alumno_id = c.alumno_id
        ) gi ON TRUE
      ),
      fam AS (
        SELECT
          r.alumno_id, r.nombre, r.apellidos, r.instrumento_key,
          i.familia AS familia_key
        FROM res r
        LEFT JOIN instrumentos i
               ON lower(btrim(i.nombre)) = lower(btrim(r.instrumento_key))
      )
      SELECT * FROM fam
    `;
    const { rows } = await db.query(sql, [eventoId]);

    const famSet  = new Set((tpl.familias_incluir || []).map(s => norm(s)));
    const instSet = new Set((tpl.instrumentos_incluir || []).map(s => norm(s)));

    // Si la plantilla tiene alumnos_ids guardados, usarlos directamente
    const alumnosIds = tpl.horas?.alumnos_ids;
    const alumnosExtra = tpl.horas?.alumnos_extra || [];

    let match;
    if (Array.isArray(alumnosIds) && alumnosIds.length) {
      const idSet = new Set(alumnosIds.map(Number));
      match = rows.filter(r => idSet.has(r.alumno_id));
      // Añadir extras (invitados/reservas) que no están en rows (no son del grupo)
      // se añaden como entradas especiales
    } else {
      match = rows.filter(r => {
        const fOk = !!r.familia_key && famSet.has(norm(r.familia_key));
        const iOk = !!r.instrumento_key && instSet.has(norm(r.instrumento_key));
        if (instSet.size) return iOk;
        if (famSet.size) return fOk;
        return true;
      });
    }

    res.json({
      plantilla: { id: tpl.id, nombre: tpl.nombre, descripcion: tpl.descripcion },
      eventoId,
      total_candidatos: rows.length,
      total_match: match.length + alumnosExtra.length,
      alumnos: match.map(r => ({
        id: r.alumno_id,
        nombre: r.nombre,
        apellidos: r.apellidos,
        instrumento: r.instrumento_key,
        familia: r.familia_key
      })),
      alumnos_extra: alumnosExtra
    });
  } catch (err) {
    console.error('GET /:pid/preview', err);
    res.status(500).json({ error: 'Error generando preview' });
  }
});

/* ---------- PUT /:pid (editar) ---------- */
router.put('/:pid', async (req, res) => {
  const pid = Number(req.params.pid);
  const { nombre, descripcion, familias_incluir, instrumentos_incluir } = req.body || {};
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rows } = await db.query(
      `UPDATE plantillas_evento
         SET nombre                 = COALESCE($2, nombre),
             descripcion            = COALESCE($3, descripcion),
             familias_incluir       = COALESCE($4::text[], familias_incluir),
             instrumentos_incluir   = COALESCE($5::text[], instrumentos_incluir)
       WHERE id=$1
       RETURNING *`,
      [pid, nombre ?? null, descripcion ?? null, familias_incluir ?? null, instrumentos_incluir ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok:true, plantilla: rows[0] });
  } catch (err) {
    console.error('PUT /:pid', err);
    res.status(500).json({ error: 'Error actualizando' });
  }
});

/* ---------- DELETE /:pid ---------- */
router.delete('/:pid', async (req, res) => {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const r = await db.query(`DELETE FROM plantillas_evento WHERE id=$1`, [pid]);
    res.json({ ok: true, deleted: r.rowCount > 0 });
  } catch (err) {
    console.error('DELETE /:pid', err);
    res.status(500).json({ error: 'Error borrando' });
  }
});

router.post('/:pid/apply', async (req, res) => {
    const pid = Number(req.params.pid);
    const eventoId = Number(req.body?.eventoId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
  
    // Logs de entrada para depurar rápidamente
    console.log('[tpl.apply] pid=', pid, 'eventoId=', eventoId, 'items.len=', items.length);
  
    if (!Number.isInteger(pid) || !Number.isInteger(eventoId)) {
      return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
    }
  
    // Validación mínima de items: alumno_id numérico
    const saneItems = items.filter(x => Number.isInteger(Number(x.alumno_id)));
    if (saneItems.length === 0) {
      return res.status(400).json({ ok: false, error: 'Lista de alumnos vacía' });
    }
  
    const client = await db.connect();
    try {
      await client.query('BEGIN');
  
      // Verificamos que la plantilla exista (opcional pero útil)
      const tpl = (await client.query(
        'SELECT id, nombre FROM plantillas_evento WHERE id=$1',
        [pid]
      )).rows[0];
      if (!tpl) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok:false, error:'Plantilla no encontrada' });
      }
  
      // Temp table para normalizar tipos, con CAST seguro a time/int
      await client.query(`
        CREATE TEMP TABLE _tpl_items (
          alumno_id int PRIMARY KEY,
          hora_inicio time,
          hora_fin    time,
          actividad_complementaria_id int,
          notas text
        ) ON COMMIT DROP;
      `);
  
      // Insertamos desde JSON → CAST explícito:
      // - NULLIF(...,'')::time evita el error “time vs text”
      // - actividad_complementaria_id puede venir null o '' (lo tratamos)
      await client.query(`
        INSERT INTO _tpl_items (alumno_id, hora_inicio, hora_fin, actividad_complementaria_id, notas)
        SELECT
          (x->>'alumno_id')::int,
          NULLIF(x->>'hora_inicio','')::time,
          NULLIF(x->>'hora_fin','')::time,
          NULLIF(x->>'actividad_complementaria_id','')::int,
          NULLIF(x->>'notas','')::text
        FROM jsonb_array_elements($1::jsonb) AS x
      `, [JSON.stringify(saneItems)]);
  
      // 1) BORRAR lo que no está en la plantilla (asistencias y asignaciones del evento)
      const delAsist = await client.query(`
        DELETE FROM asistencias a
        WHERE a.evento_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM _tpl_items t WHERE t.alumno_id = a.alumno_id
          )
      `, [eventoId]);
  
      const delAsig = await client.query(`
        DELETE FROM evento_asignaciones ea
        WHERE ea.evento_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM _tpl_items t WHERE t.alumno_id = ea.alumno_id
          )
      `, [eventoId]);
  
      // 2) UPSERT de lo que sí está en la plantilla (reemplaza horas/actividad/notas)
      const upsert = await client.query(`
        INSERT INTO evento_asignaciones
          (evento_id, alumno_id, hora_inicio, hora_fin, actividad_complementaria_id, notas)
        SELECT $1, t.alumno_id, t.hora_inicio, t.hora_fin, t.actividad_complementaria_id, t.notas
        FROM _tpl_items t
        ON CONFLICT (evento_id, alumno_id) DO UPDATE SET
          hora_inicio = EXCLUDED.hora_inicio,
          hora_fin    = EXCLUDED.hora_fin,
          actividad_complementaria_id = EXCLUDED.actividad_complementaria_id,
          notas       = EXCLUDED.notas
      `, [eventoId]);
  
      await client.query('COMMIT');
  
      console.log('[tpl.apply] OK', {
        kept: upsert.rowCount,        // upserts (insertados+actualizados)
        removed_asist: delAsist.rowCount,
        removed_asig: delAsig.rowCount
      });
  
      return res.json({
        ok: true,
        kept: upsert.rowCount,
        removed_asist: delAsist.rowCount,
        removed_asig: delAsig.rowCount
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /plantillas/:pid/apply ERROR:', err);
      return res.status(500).json({ ok:false, error:'Error guardando resultado de la plantilla' });
    } finally {
      client.release();
    }
  });
  /* ---------- PUT /:pid (editar + horas) ---------- */
router.put('/:pid', async (req, res) => {
  const pid = Number(req.params.pid);
  const { nombre, descripcion, familias_incluir, instrumentos_incluir } = req.body || {};
  const horas = sanitizeHoras(req.body?.horas);
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rows } = await db.query(
      `UPDATE plantillas_evento
         SET nombre                 = COALESCE($2, nombre),
             descripcion            = COALESCE($3, descripcion),
             familias_incluir       = COALESCE($4::text[], familias_incluir),
             instrumentos_incluir   = COALESCE($5::text[], instrumentos_incluir),
             horas                  = COALESCE($6::jsonb, horas)
       WHERE id=$1
       RETURNING *`,
      [pid, nombre ?? null, descripcion ?? null, familias_incluir ?? null, instrumentos_incluir ?? null, horas ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok:true, plantilla: rows[0] });
  } catch (err) {
    console.error('PUT /:pid', err);
    res.status(500).json({ error: 'Error actualizando' });
  }
});

  module.exports = router;
