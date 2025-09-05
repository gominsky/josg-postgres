const express = require('express');
const router = express.Router();
const db = require('../database/db');
const QRCode = require('qrcode');
const { toISODate } = require('../utils/fechas');
const { pdfControlAsistencia } = require('../utils/pdfControlAsistencia');

/* -------------------------------------------
   Helpers comunes
------------------------------------------- */

// "YYYY-MM-DDTHH:MM" → {fechaISO, horaHHMM}
function splitISODateTime(input) {
  if (!input) return { fechaISO: null, horaHHMM: null };
  if (typeof input === 'string' && input.includes('T')) {
    const [d, t] = input.split('T');
    return { fechaISO: toISODate(d), horaHHMM: (t || '').slice(0, 5) || null };
  }
  return { fechaISO: toISODate(input), horaHHMM: null };
}

function hhmmOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && /^\d{2}:\d{2}$/.test(t) ? t : null;
}
function idOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}
function strOrNull(v) {
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
}

// Normaliza fecha a 'YYYY-MM-DD' sin UTC shift
const toISO10 = v => {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  if (s.includes('T')) return s.split('T')[0];
  return s.slice(0,10);
};

/**
 * Decide el valor final a guardar en `instrumento`:
 * - Si NO es violín → null (no forzamos).
 * - Si es violín y (aparte del grupo del evento) pertenece a "Violín I" o "Violín II":
 *   "Violín I" (prioridad) o "Violín II".
 */
async function decideInstrumentoParaAlumno(client, { alumnoId, eventoGrupoId }) {
  // 1) ¿El alumno toca violín? (desde relaciones)
  const qBase = `
    SELECT
      MAX(CASE WHEN ins.nombre ~* '^\\s*viol(í|i)n(\\s|$)' THEN 1 ELSE 0 END) AS es_violin
    FROM alumno_instrumento ai
    JOIN instrumentos ins ON ins.id = ai.instrumento_id
    WHERE ai.alumno_id = $1
  `;
  const rBase = await client.query(qBase, [alumnoId]);
  const esViolin = !!Number(rBase.rows[0]?.es_violin || 0);
  if (!esViolin) return null;

  // 2) ¿Pertenece a Violín I/II (excluyendo opcionalmente el grupo del evento)?
  const qGrupos = `
    SELECT
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)'  THEN 1 ELSE 0 END) AS en_v1,
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*ii)(\\b|\\s|$)' THEN 1 ELSE 0 END) AS en_v2
    FROM alumno_grupo ag
    JOIN grupos g ON g.id = ag.grupo_id
    WHERE ag.alumno_id = $1
      AND ($2::int IS NULL OR g.id <> $2)
  `;
  const rG = await client.query(qGrupos, [alumnoId, eventoGrupoId ?? null]);
  const enV1 = !!Number(rG.rows[0]?.en_v1 || 0);
  const enV2 = !!Number(rG.rows[0]?.en_v2 || 0);

  if (enV1) return 'Violín I';
  if (enV2) return 'Violín II';
  return null;
}

/**
 * Foto de alumnos del grupo → evento_asignaciones
 * Copia horas del evento, casteadas a TIME de forma segura.
 */
async function asignarAlumnosAEvento(db, eventoId, grupoId) {
  if (!grupoId) return;

  const sql = `
    INSERT INTO evento_asignaciones (evento_id, alumno_id, hora_inicio, hora_fin)
    SELECT
      $1 AS evento_id,
      al.id AS alumno_id,
      CASE
        WHEN e.hora_inicio IS NULL OR NULLIF(trim(e.hora_inicio::text), '') IS NULL THEN NULL
        ELSE left(e.hora_inicio::text, 8)::time
      END AS hora_inicio,
      CASE
        WHEN e.hora_fin IS NULL OR NULLIF(trim(e.hora_fin::text), '') IS NULL THEN NULL
        ELSE left(e.hora_fin::text, 8)::time
      END AS hora_fin
    FROM alumno_grupo ag
    JOIN alumnos al ON al.id = ag.alumno_id
    JOIN eventos  e ON e.id   = $1
    WHERE ag.grupo_id = $2
      AND COALESCE(al.activo, TRUE) IS TRUE
      AND (
        al.fecha_matriculacion IS NULL
        OR to_date(left(al.fecha_matriculacion::text, 10), 'YYYY-MM-DD')
           <= to_date(left(e.fecha_inicio::text, 10), 'YYYY-MM-DD')
      )
      AND (
        al.fecha_baja IS NULL
        OR to_date(left(al.fecha_baja::text, 10), 'YYYY-MM-DD')
           >= to_date(left(e.fecha_inicio::text, 10), 'YYYY-MM-DD')
      )
  ON CONFLICT (evento_id, alumno_id) DO NOTHING
  `;

  await db.query(sql, [Number(eventoId), Number(grupoId)]);
}

/* -------------------------------------------
   AYUDA
------------------------------------------- */
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_eventos', { title: 'Ayuda · Eventos', hero: false });
});

/* -------------------------------------------
   LISTADO JSON (FullCalendar)
------------------------------------------- */
router.get('/listado', async (_req, res) => {
  const sql = `
  WITH e2 AS (
    SELECT
      e.*,
      CASE
        WHEN (e.fecha_inicio::text) ~ 'T'
          THEN to_timestamp(e.fecha_inicio::text, 'YYYY-MM-DD"T"HH24:MI')
        ELSE to_timestamp((e.fecha_inicio::text) || ' ' || COALESCE(e.hora_inicio::text,'00:00'), 'YYYY-MM-DD HH24:MI')
      END AS start_ts,
      CASE
        WHEN (e.fecha_fin::text) ~ 'T'
          THEN to_timestamp(e.fecha_fin::text, 'YYYY-MM-DD"T"HH24:MI')
        ELSE to_timestamp((e.fecha_fin::text) || ' ' || COALESCE(e.hora_fin::text,'00:00'), 'YYYY-MM-DD HH24:MI')
      END AS end_ts
    FROM eventos e
  )
  SELECT e2.id, e2.titulo, e2.descripcion, e2.grupo_id, e2.activo,
         g.nombre AS grupo_nombre,
         to_char(e2.start_ts, 'YYYY-MM-DD"T"HH24:MI') AS start_iso,
         to_char(e2.end_ts,   'YYYY-MM-DD"T"HH24:MI') AS end_iso
  FROM e2
  LEFT JOIN grupos g ON e2.grupo_id = g.id
`;
  try {
    const { rows } = await db.query(sql);

    const cleanText = (text) =>
      (text || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B]/g, '').trim();

    const eventos = rows.map(row => {
      const tituloLimpio = cleanText(row.titulo);
      const grupoLimpio = cleanText(row.grupo_nombre || 'Sin grupo');
      const descripcionLimpia = cleanText(row.descripcion || '');

      return {
        id: row.id,
        title: tituloLimpio ? `${tituloLimpio} (${grupoLimpio})` : `Evento sin título`,
        start: row.start_iso,
        end: row.end_iso,
        titulo: tituloLimpio,
        descripcion: descripcionLimpia,
        grupo_id: row.grupo_id,
        grupo: grupoLimpio,
        activo: row.activo,
        backgroundColor: '#2a4b7c',
        borderColor: '#2a4b7c'
      };
    });

    res.json(eventos);
  } catch (err) {
    console.error('Error al obtener eventos:', err);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

/* -------------------------------------------
   VISTA PRINCIPAL: Calendario/Lista
------------------------------------------- */
router.get('/', async (req, res) => {
  const desdeRaw = req.query.desde || '';
  const hastaRaw = req.query.hasta || '';
  const desde = toISODate(desdeRaw);
  const hasta = toISODate(hastaRaw);

  if (desde && hasta) {
    const query = `
  WITH e2 AS (
    SELECT e.*,
      CASE
        WHEN (e.fecha_inicio::text) ~ 'T'
          THEN to_timestamp(e.fecha_inicio::text, 'YYYY-MM-DD"T"HH24:MI')
        ELSE to_timestamp((e.fecha_inicio::text) || ' ' || COALESCE(e.hora_inicio::text,'00:00'), 'YYYY-MM-DD HH24:MI')
      END AS start_ts,
      CASE
        WHEN (e.fecha_fin::text) ~ 'T'
          THEN to_timestamp(e.fecha_fin::text, 'YYYY-MM-DD"T"HH24:MI')
        ELSE to_timestamp((e.fecha_fin::text) || ' ' || COALESCE(e.hora_fin::text,'00:00'), 'YYYY-MM-DD HH24:MI')
      END AS end_ts
    FROM eventos e
  )
  SELECT e2.*, g.nombre AS grupo_nombre
  FROM e2
  JOIN grupos g ON e2.grupo_id = g.id
  WHERE e2.start_ts::date >= $1::date
    AND e2.end_ts::date   <= $2::date
  ORDER BY e2.start_ts
`;
    try {
      const { rows: eventos } = await db.query(query, [desde, hasta]);
      const { rows: grupos } = await db.query('SELECT * FROM grupos ORDER BY nombre');
      res.render('eventos_lista', { eventos, grupos });
    } catch (error) {
      console.error('Error al obtener eventos entre fechas:', error);
      res.status(500).send('Error al obtener eventos');
    }
  } else {
    const grupos = (await db.query('SELECT * FROM grupos ORDER BY nombre')).rows;
    res.render('eventos_lista', { eventos: null, grupos });
  }
});

/* -------------------------------------------
   OBTENER 1 EVENTO (JSON)
------------------------------------------- */
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const result = await db.query('SELECT * FROM eventos WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al obtener el evento:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* -------------------------------------------
   CREAR EVENTO (con foto de asignaciones)
------------------------------------------- */
router.post('/', async (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;

  const activoValue = (activo === '1');
  const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
  const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);
  if (!fIniISO || !fFinISO) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }

  const hora_inicio = hhmmOrNull(hiFromIni);
  const hora_fin    = hhmmOrNull(hfFromFin);
  const token = Math.random().toString(36).substring(2, 10);

  const sql = `
    INSERT INTO eventos (
      titulo, descripcion, fecha_inicio, fecha_fin, grupo_id,
      activo, hora_inicio, hora_fin, token
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `;

  const params = [
    titulo?.trim() || null,
    descripcion?.trim() || null,
    fIniISO,
    fFinISO,
    grupo_id || null,
    activoValue,
    hora_inicio,
    hora_fin,
    token
  ];

  try {
    await db.query('BEGIN');
    const result = await db.query(sql, params);
    const newId = result.rows[0].id;

    if (grupo_id) {
      await asignarAlumnosAEvento(db, newId, grupo_id, fIniISO); // arg extra ignorado
    }

    await db.query('COMMIT');
    res.json({ id: newId });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error al guardar evento:', err);
    res.status(500).json({ error: 'Error al guardar evento' });
  }
});

/* -------------------------------------------
   CREAR EVENTOS MASIVOS
------------------------------------------- */
router.post('/masivo', async (req, res) => {
  const {
    titulo, descripcion, grupo_id, activo,
    hora_inicio, hora_fin, // HH:MM
    fechas // ['YYYY-MM-DD']
  } = req.body;

  try {
    const activoValue = (activo === '1');
    if (!titulo || !grupo_id || !Array.isArray(fechas) || fechas.length === 0) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    if (!hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan horas de inicio/fin' });
    }

    await db.query('BEGIN');

    const insertSQL = `
      INSERT INTO eventos (
        titulo, descripcion, fecha_inicio, fecha_fin, grupo_id,
        activo, hora_inicio, hora_fin, token
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, fecha_inicio
    `;

    const ids = [];
    for (const fISO of fechas) {
      const fecha_inicio = toISODate(fISO);
      const fecha_fin = fecha_inicio;
      const token = Math.random().toString(36).substring(2, 10);

      const params = [
        titulo?.trim() || null,
        descripcion?.trim() || null,
        fecha_inicio,
        fecha_fin,
        Number(grupo_id),
        activoValue,
        hhmmOrNull(hora_inicio),
        hhmmOrNull(hora_fin),
        token
      ];
      const r = await db.query(insertSQL, params);
      const evId = r.rows[0].id;
      ids.push(evId);

      await asignarAlumnosAEvento(db, evId, Number(grupo_id), fecha_inicio);
    }

    await db.query('COMMIT');
    return res.json({ created: ids.length, ids });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error en creación masiva:', err);
    return res.status(500).json({ error: 'Error al crear eventos masivos' });
  }
});

/* -------------------------------------------
   ACTUALIZAR EVENTO
------------------------------------------- */
router.put('/:id', async (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;
  const id = parseInt(req.params.id, 10);

  const activoValue = (activo === '1');
  const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
  const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);
  if (!fIniISO || !fFinISO) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }

  const hora_inicio = hhmmOrNull(hiFromIni);
  const hora_fin    = hhmmOrNull(hfFromFin);

  const sql = `
    UPDATE eventos
    SET titulo = $1,
        descripcion = $2,
        fecha_inicio = $3,
        fecha_fin = $4,
        grupo_id = $5,
        activo = $6,
        hora_inicio = $7,
        hora_fin = $8
    WHERE id = $9
  `;

  const params = [
    titulo?.trim() || null,
    descripcion?.trim() || null,
    fIniISO,
    fFinISO,
    grupo_id || null,
    activoValue,
    hora_inicio,
    hora_fin,
    id
  ];

  try {
    await db.query(sql, params);
    res.json({ updated: true });
  } catch (err) {
    console.error('Error al actualizar evento:', err);
    res.status(500).json({ error: 'Error al actualizar evento' });
  }
});

/* -------------------------------------------
   ELIMINAR EVENTO (y dependencias)
------------------------------------------- */
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    await db.query('DELETE FROM guardias WHERE evento_id = $1', [id]);
    await db.query('DELETE FROM asistencias WHERE evento_id = $1', [id]);
    await db.query('DELETE FROM eventos WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error al eliminar evento:', err);
    res.status(500).json({ error: 'Error al eliminar evento' });
  }
});

/* -------------------------------------------
   QR DEL EVENTO
------------------------------------------- */
router.get('/:id/qr', async (req, res) => {
  const eventoId = req.params.id;

  const eventoSQL = `
    SELECT e.*, g.nombre AS grupo_nombre
    FROM eventos e
    JOIN grupos g ON e.grupo_id = g.id
    WHERE e.id = $1
  `;

  try {
    const { rows } = await db.query(eventoSQL, [eventoId]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');

    const evento = rows[0];
    const tituloConGrupo = `${evento.titulo}${evento.grupo_nombre ? ` (${evento.grupo_nombre})` : ''}`;

    const qrData = JSON.stringify({ evento_id: evento.id, token: evento.token });
    const qrDataUrl = await QRCode.toDataURL(qrData);

    const fISO = toISODate(evento.fecha_inicio);
    const hhmm = (evento.hora_inicio || '00:00');
    const fechaObj = fISO ? new Date(`${fISO}T${hhmm}:00`) : null;

    const fechaFormateada = fechaObj
      ? fechaObj.toLocaleString('es-ES', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Madrid'
        })
      : (evento.fecha_inicio || '');

    res.send(`
      <html>
        <head>
          <title>QR para ${tituloConGrupo}</title>
          <style>
            body { font-family: sans-serif; text-align: center; background: #f4f4f4; padding: 2rem; }
            .qr-container { background: white; display: inline-block; padding: 2rem; border-radius: 1rem; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
            img { width: 300px; height: 300px; }
            button { margin-top: 1.5rem; padding: 0.8rem 2rem; font-size: 1rem; border: none; border-radius: 0.5rem; background-color: #FF9501; color: white; cursor: pointer; }
            @media print { button { display: none; } }
          </style>
        </head>
        <body>
          <div class="qr-container">
            <h2>${tituloConGrupo}</h2>
            <p><strong>${fechaFormateada}</strong></p>
            <img src="${qrDataUrl}" alt="QR Evento ${tituloConGrupo}" />
            <p style="margin-top:1rem;color:gray;">Escanéalo con la app del alumno</p>
            <button onclick="window.print()">Imprimir QR</button>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error generando el QR:', err);
    res.status(500).send('Error generando el QR');
  }
});

/* -------------------------------------------
   FIRMA MANUAL: FORM
------------------------------------------- */
router.get('/:id/firma_manual', async (req, res) => {
  const eventoId = parseInt(req.params.id, 10);
  if (isNaN(eventoId)) return res.status(400).send('ID inválido');

  const eventoSQL = `
    SELECT e.*, g.nombre AS grupo_nombre
    FROM eventos e
    LEFT JOIN grupos g ON g.id = e.grupo_id
    WHERE e.id = $1
  `;

  const asignacionesSQL = `
  WITH base AS (
    SELECT
      a.id,
      a.nombre,
      a.apellidos,
      a.dni,

      string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,

      bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro,

      CASE WHEN asi.alumno_id IS NOT NULL THEN 1 ELSE 0 END AS firmado,

      ea.hora_inicio, ea.hora_fin, ea.instrumento, ea.notas,
      ea.ausencia_tipo_id, au.tipo AS ausencia_tipo,
      ea.actividad_complementaria_id, ac.tipo AS actividad_complementaria
    FROM evento_asignaciones ea
    JOIN alumnos a  ON a.id = ea.alumno_id
    LEFT JOIN asistencias asi
           ON asi.evento_id = ea.evento_id
          AND asi.alumno_id = ea.alumno_id
    LEFT JOIN ausencias au ON au.id = ea.ausencia_tipo_id
    LEFT JOIN actividades_complementarias ac ON ac.id = ea.actividad_complementaria_id
    LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
    LEFT JOIN instrumentos ins      ON ins.id = ai.instrumento_id
    WHERE ea.evento_id = $1
    GROUP BY
      a.id, a.nombre, a.apellidos, a.dni,
      firmado,
      ea.hora_inicio, ea.hora_fin, ea.instrumento, ea.notas,
      ea.ausencia_tipo_id, au.tipo,
      ea.actividad_complementaria_id, ac.tipo
  ),
  grupos_violin AS (
    SELECT
      b.id AS alumno_id,
      bool_or(g2.nombre ~* '^\\s*viol(í|i)n\\s*(ii|2)\\b') AS en_violin_ii,
      bool_or(g2.nombre ~* '^\\s*viol(í|i)n\\s*i\\b')      AS en_violin_i
    FROM base b
    LEFT JOIN alumno_grupo ag2 ON ag2.alumno_id = b.id
    LEFT JOIN grupos g2        ON g2.id = ag2.grupo_id
    GROUP BY b.id
  ),
  etiquetado AS (
    SELECT
      b.*,
      CASE
        WHEN b.has_violin_puro IS TRUE THEN
          CASE
            WHEN gv.en_violin_ii THEN 'Violín II'
            WHEN gv.en_violin_i  THEN 'Violín I'
            ELSE 'Violín'
          END
        ELSE
          COALESCE(split_part(b.instrumentos, ', ', 1), '')
      END AS instrumento_mostrado
    FROM base b
    LEFT JOIN grupos_violin gv ON gv.alumno_id = b.id
  )
  SELECT
    id, nombre, apellidos, dni,
    instrumentos,
    instrumento_mostrado,
    firmado,
    hora_inicio, hora_fin, instrumento, notas,
    ausencia_tipo_id, ausencia_tipo,
    actividad_complementaria_id, actividad_complementaria
  FROM etiquetado
  ORDER BY apellidos NULLS LAST, nombre NULLS LAST, id
`;

  try {
    const { rows: eventoRows } = await db.query(eventoSQL, [eventoId]);
    if (eventoRows.length === 0) return res.status(404).send('Evento no encontrado');

    const evento = eventoRows[0];
    const fechaISO = toISO10(evento.fecha_inicio);

    // Cargar asignaciones
    let { rows: alumnos } = await db.query(asignacionesSQL, [eventoId]);

    // Si no hay asignaciones y el evento tiene grupo, repoblar y reintentar
    if ((!alumnos || alumnos.length === 0) && evento.grupo_id && fechaISO) {
      try {
        await asignarAlumnosAEvento(db, eventoId, evento.grupo_id, fechaISO);
        const retry = await db.query(asignacionesSQL, [eventoId]);
        alumnos = retry.rows;
      } catch (e) {
        console.error('Auto-repoblar falló:', e);
      }
    }

    // Cabecera fecha/hora (zona Madrid)
    const horaIni = (evento.hora_inicio || '').slice(0, 5) || null;
    const horaFin = (evento.hora_fin || '').slice(0, 5) || null;

    let iniTxt = evento.fecha_inicio || '—';
    let hIni = horaIni || '—';
    let hFin = horaFin || '—';

    if (fechaISO) {
      const [y, m, d] = fechaISO.split('-').map(Number);
      const midUTC = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0));
      iniTxt = midUTC.toLocaleDateString('es-ES', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/Madrid'
      });
    }

    const firmados = (alumnos || []).filter(a => a.firmado).map(a => a.id);

    res.render('firma_manual', {
      evento,
      alumnos: alumnos || [],
      firmados,
      iniTxt,
      hIni,
      hFin
    });
  } catch (err) {
    console.error('Error al cargar formulario de firmas:', err);
    res.status(500).send('Error al cargar formulario de firmas');
  }
});

/* -------------------------------------------
   FIRMA MANUAL: AJAX (marca asistencia)
------------------------------------------- */
router.post('/:id/firma_manual/ajax', async (req, res) => {
  const eventoId = Number(req.params.id);
  const alumnoId = Number(req.body.alumno_id);
  const firmado = String(req.body.firmado) === 'true';

  if (!Number.isInteger(eventoId) || !Number.isInteger(alumnoId)) {
    return res.status(400).json({ success: false, error: 'Parámetros inválidos' });
  }

  try {
    await db.query('BEGIN');

    // Debe existir asignación
    const asig = await db.query(
      'SELECT 1 FROM evento_asignaciones WHERE evento_id = $1 AND alumno_id = $2',
      [eventoId, alumnoId]
    );
    if (!asig.rows.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Alumno no asignado a este evento' });
    }

    if (firmado) {
      await db.query(
        `INSERT INTO asistencias (evento_id, alumno_id)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM asistencias WHERE evento_id = $1 AND alumno_id = $2
         )`,
        [eventoId, alumnoId]
      );
      await db.query(
        `UPDATE evento_asignaciones
            SET ausencia_tipo_id = NULL
          WHERE evento_id = $1 AND alumno_id = $2`,
        [eventoId, alumnoId]
      );
    } else {
      await db.query(
        'DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2',
        [eventoId, alumnoId]
      );
    }

    await db.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error actualizando firma AJAX:', err);
    return res.status(500).json({ success: false, error: 'Error actualizando firma' });
  }
});

/* -------------------------------------------
   PDF CONTROL DE ASISTENCIA
------------------------------------------- */
router.get('/:id/firmas.pdf', async (req, res, next) => {
  try {
    const eventoId = Number(req.params.id);
    if (!Number.isInteger(eventoId)) return res.status(400).send('ID no válido');
    await pdfControlAsistencia(db, res, eventoId);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------
   ========== ASIGNACIONES ==========
------------------------------------------- */

// Listar asignaciones
router.get('/:id/asignaciones', async (req, res) => {
  const eventoId = Number(req.params.id);
  if (!Number.isInteger(eventoId)) return res.status(400).json({ error: 'ID inválido' });

  const sql = `
    SELECT
      ea.evento_id,
      ea.alumno_id,
      a.nombre,
      a.apellidos,
      ea.hora_inicio,
      ea.hora_fin,
      COALESCE(ea.hora_inicio, e.hora_inicio) AS hora_inicio_efectiva,
      COALESCE(ea.hora_fin,    e.hora_fin)    AS hora_fin_efectiva,
      ea.instrumento,
      ea.notas,
      ea.ausencia_tipo_id,
      au.tipo  AS ausencia_tipo,
      ea.actividad_complementaria_id,
      ac.tipo  AS actividad_complementaria
    FROM evento_asignaciones ea
    JOIN alumnos a  ON a.id = ea.alumno_id
    JOIN eventos e  ON e.id = ea.evento_id
    LEFT JOIN ausencias au ON au.id = ea.ausencia_tipo_id
    LEFT JOIN actividades_complementarias ac ON ac.id = ea.actividad_complementaria_id
    WHERE ea.evento_id = $1
    ORDER BY a.apellidos NULLS LAST, a.nombre NULLS LAST, a.id
  `;
  try {
    const { rows } = await db.query(sql, [eventoId]);
    res.json(rows);
  } catch (err) {
    console.error('Error obteniendo asignaciones:', err);
    res.status(500).json({ error: 'Error obteniendo asignaciones' });
  }
});

// Repoblar desde grupo del evento (añade faltantes)
router.post('/:id/asignaciones/refresh', async (req, res) => {
  const eventoId = Number(req.params.id);
  const e = (await db.query('SELECT grupo_id, fecha_inicio FROM eventos WHERE id = $1', [eventoId])).rows[0];
  if (!e) return res.status(404).json({ error: 'Evento no encontrado' });

  const fechaISO = String(e.fecha_inicio).slice(0, 10);

  try {
    await asignarAlumnosAEvento(db, eventoId, e.grupo_id, fechaISO); // arg extra ignorado
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error refrescando asignaciones:', err);
    return res.status(500).json({ error: 'Error refrescando asignaciones' });
  }
});

// Actualizar una asignación (horas, instrumento, notas, ausencia, actividad) + regla Violín I/II
router.put('/:id/asignaciones/:alumnoId', async (req, res) => {
  const eventoId = Number(req.params.id);
  const alumnoId = Number(req.params.alumnoId);
  if (!Number.isInteger(eventoId) || !Number.isInteger(alumnoId)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  const toNullIfEmpty = v =>
    (v === '' || v === undefined || v === null) ? null : String(v);
  const toIntOrNull = v => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };

  const body = req.body || {};
  const payload = {
    hora_inicio: toNullIfEmpty(body.hora_inicio),
    hora_fin:    toNullIfEmpty(body.hora_fin),
    instrumento: toNullIfEmpty(body.instrumento),
    notas:       toNullIfEmpty(body.notas),
    ausencia_tipo_id:            toIntOrNull(body.ausencia_tipo_id),
    actividad_complementaria_id: toIntOrNull(body.actividad_complementaria_id)
  };

  try {
    await db.query('BEGIN');

    // Verifica existencia
    const ex = await db.query(
      'SELECT 1 FROM evento_asignaciones WHERE evento_id = $1 AND alumno_id = $2',
      [eventoId, alumnoId]
    );
    if (!ex.rows.length) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Asignación no encontrada' });
    }

    // Grupo del evento para la regla Violín I/II
    const evRow = await db.query('SELECT grupo_id FROM eventos WHERE id=$1', [eventoId]);
    const eventoGrupoId = evRow.rows[0]?.grupo_id ?? null;

    // Aplica regla Violín I/II si corresponde
    const client = await db.connect();
    try {
      const vi = await decideInstrumentoParaAlumno(client, { alumnoId, eventoGrupoId });
      if (vi) payload.instrumento = vi;
    } finally {
      client.release();
    }

    const upd = await db.query(
      `UPDATE evento_asignaciones
          SET hora_inicio = $3,
              hora_fin    = $4,
              instrumento = $5,
              notas       = $6,
              ausencia_tipo_id = $7,
              actividad_complementaria_id = $8
        WHERE evento_id = $1 AND alumno_id = $2
        RETURNING evento_id, alumno_id, hora_inicio, hora_fin, instrumento, notas,
                  ausencia_tipo_id, actividad_complementaria_id`,
      [
        eventoId,
        alumnoId,
        payload.hora_inicio,
        payload.hora_fin,
        payload.instrumento,
        payload.notas,
        payload.ausencia_tipo_id,
        payload.actividad_complementaria_id
      ]
    );

    // Manejo de firmas si el front decide enviarlas aquí (opcional)
    if ('firmado' in body) {
      if (body.firmado === true || body.firmado === 'true' || body.firmado === 1 || body.firmado === '1') {
        await db.query(
          `INSERT INTO asistencias (evento_id, alumno_id)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM asistencias WHERE evento_id = $1 AND alumno_id = $2
           )`,
          [eventoId, alumnoId]
        );
        await db.query(
          `UPDATE evento_asignaciones
              SET ausencia_tipo_id = NULL
            WHERE evento_id = $1 AND alumno_id = $2`,
          [eventoId, alumnoId]
        );
      } else if (body.firmado === false || body.firmado === 'false' || body.firmado === 0 || body.firmado === '0') {
        await db.query(
          'DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2',
          [eventoId, alumnoId]
        );
      }
    }

    await db.query('COMMIT');
    return res.json(upd.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error actualizando asignación:', err);
    return res.status(500).json({ error: 'Error actualizando asignación' });
  }
});

// Eliminar asignación
router.delete('/:id/asignaciones/:alumnoId', async (req, res) => {
  const eventoId = Number(req.params.id);
  const alumnoId = Number(req.params.alumnoId);
  if (!Number.isInteger(eventoId) || !Number.isInteger(alumnoId)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  try {
    const { rowCount } = await db.query(
      'DELETE FROM evento_asignaciones WHERE evento_id=$1 AND alumno_id=$2',
      [eventoId, alumnoId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando asignación:', err);
    res.status(500).json({ error: 'Error eliminando asignación' });
  }
});

// Resumen asignación/asistencia
router.get('/:id/asignaciones/resumen', async (req, res) => {
  const eventoId = Number(req.params.id);
  if (!Number.isInteger(eventoId)) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int AS asignados,
        COUNT(a.alumno_id)::int AS asistieron
      FROM evento_asignaciones ea
      LEFT JOIN asistencias a
        ON a.evento_id = ea.evento_id
       AND a.alumno_id = ea.alumno_id
      WHERE ea.evento_id = $1
    `, [eventoId]);
    res.json(rows[0] || { asignados: 0, asistieron: 0 });
  } catch (err) {
    console.error('Error en resumen de asignaciones:', err);
    res.status(500).json({ error: 'Error en resumen de asignaciones' });
  }
});

/* -------------------------------------------
   Guardado en lote (firma_manual)
------------------------------------------- */
router.put('/:id/firma_manual/batch', async (req, res) => {
  const eventoId = Number(req.params.id);
  const { cambios } = req.body;

  if (!Number.isInteger(eventoId) || !Array.isArray(cambios)) {
    return res.status(400).json({ ok:false, error:'Petición inválida' });
  }

  const evRow = await db.query('SELECT grupo_id FROM eventos WHERE id=$1', [eventoId]);
  const eventoGrupoId = evRow.rows[0]?.grupo_id ?? null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sqlUpsert = `
      INSERT INTO evento_asignaciones
        (evento_id, alumno_id, hora_inicio, hora_fin, instrumento, notas,
         ausencia_tipo_id, actividad_complementaria_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (evento_id, alumno_id) DO UPDATE SET
        hora_inicio = EXCLUDED.hora_inicio,
        hora_fin = EXCLUDED.hora_fin,
        instrumento = EXCLUDED.instrumento,
        notas = EXCLUDED.notas,
        ausencia_tipo_id = EXCLUDED.ausencia_tipo_id,
        actividad_complementaria_id = EXCLUDED.actividad_complementaria_id
    `;

    let count = 0;
    for (const c of cambios) {
      const alumnoId = Number(c.alumno_id);
      if (!Number.isInteger(alumnoId)) continue;

      // instrumento que llega del front
      let instrumentoFinal = (c.instrumento ?? '').toString().trim() || null;

      // Regla Violín I/II
      const vi = await decideInstrumentoParaAlumno(client, { alumnoId, eventoGrupoId });
      if (vi) instrumentoFinal = vi;

      // Upsert asignación
      await client.query(sqlUpsert, [
        eventoId,
        alumnoId,
        c.hora_inicio ?? null,
        c.hora_fin ?? null,
        instrumentoFinal,
        c.notas ?? null,
        c.ausencia_tipo_id ?? null,
        c.actividad_complementaria_id ?? null
      ]);

      // Manejo de firma en asistencias (si el front la incluye)
      if ('firmado' in c) {
        if (c.firmado === true || c.firmado === 'true' || c.firmado === 1 || c.firmado === '1') {
          await client.query(
            `INSERT INTO asistencias (evento_id, alumno_id)
             SELECT $1, $2
             WHERE NOT EXISTS (
               SELECT 1 FROM asistencias WHERE evento_id = $1 AND alumno_id = $2
             )`,
            [eventoId, alumnoId]
          );
          // Si firma, limpiamos ausencia
          await client.query(
            `UPDATE evento_asignaciones
                SET ausencia_tipo_id = NULL
              WHERE evento_id = $1 AND alumno_id = $2`,
            [eventoId, alumnoId]
          );
        } else if (c.firmado === false || c.firmado === 'false' || c.firmado === 0 || c.firmado === '0') {
          await client.query(
            'DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2',
            [eventoId, alumnoId]
          );
        }
      }

      count++;
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok:true, actualizados: count });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('batch firma_manual:', err);
    return res.status(500).json({ ok:false, error:'Error guardando cambios' });
  } finally {
    client.release();
  }
});

module.exports = router;
