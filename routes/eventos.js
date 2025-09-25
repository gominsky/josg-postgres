const express = require('express');
const router = express.Router();
const db = require('../database/db');
const QRCode = require('qrcode');
const { toISODate } = require('../utils/fechas');
const { pdfControlAsistencia } = require('../utils/pdfControlAsistencia');

function splitISODateTime(input) {
  if (!input) return { fechaISO: null, horaHHMM: null };
  if (typeof input === 'string' && input.includes('T')) {
    const [d, t] = input.split('T');
    return { fechaISO: toISODate(d), horaHHMM: (t || '').slice(0, 5) || null };
  }
  return { fechaISO: toISODate(input), horaHHMM: null };
}
function cleanText(str = '') {
  return String(str)
    .replace(/<[^>]*>/g, '') // elimina etiquetas HTML
    .replace(/\s+/g, ' ')    // normaliza espacios
    .trim();
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
async function nombreGrupoViolinSiAplica(client, alumnoId) {
  // ¿toca violín?
  const rBase = await client.query(`
    SELECT
      MAX(CASE WHEN ins.nombre ~* '^\\s*viol(í|i)n(\\s|$)' THEN 1 ELSE 0 END) AS es_violin
    FROM alumno_instrumento ai
    JOIN instrumentos ins ON ins.id = ai.instrumento_id
    WHERE ai.alumno_id = $1
  `, [alumnoId]);

  const esViolin = !!Number(rBase.rows[0]?.es_violin || 0);
  if (!esViolin) return null;

  // nº de grupos y flags "Violín I/II"
  const rG = await client.query(`
    SELECT
      COUNT(DISTINCT ag.grupo_id) AS grupos_count,
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)' THEN 1 ELSE 0 END)   AS en_v1,
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*ii|viol[ií]n\\s*2)(\\b|\\s|$)' THEN 1 ELSE 0 END) AS en_v2
    FROM alumno_grupo ag
    JOIN grupos g ON g.id = ag.grupo_id
    WHERE ag.alumno_id = $1
  `, [alumnoId]);

  const gruposCount = Number(rG.rows[0]?.grupos_count || 0);
  const enV1 = !!Number(rG.rows[0]?.en_v1 || 0);
  const enV2 = !!Number(rG.rows[0]?.en_v2 || 0);

  if (gruposCount > 1) {
    if (enV1) return 'Violín I';  // prioridad I
    if (enV2) return 'Violín II';
  }
  return null;
}
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
async function decideInstrumentoParaAlumno(client, { alumnoId }) {
  // ¿toca violín?
  const rBase = await client.query(`
    SELECT
      MAX(CASE WHEN ins.nombre ~* '^\\s*viol(í|i)n(\\s|$)' THEN 1 ELSE 0 END) AS es_violin
    FROM alumno_instrumento ai
    JOIN instrumentos ins ON ins.id = ai.instrumento_id
    WHERE ai.alumno_id = $1
  `, [alumnoId]);
  const esViolin = !!Number(rBase.rows[0]?.es_violin || 0);
  if (!esViolin) return null;

  // nº de grupos y flags Violín I / Violín II
  const rG = await client.query(`
    SELECT
      COUNT(DISTINCT ag.grupo_id) AS grupos_count,
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)'  THEN 1 ELSE 0 END) AS en_v1,
      MAX(CASE WHEN LOWER(g.nombre) ~ '(viol[ií]n\\s*ii|viol[ií]n\\s*2)(\\b|\\s|$)' THEN 1 ELSE 0 END) AS en_v2
    FROM alumno_grupo ag
    JOIN grupos g ON g.id = ag.grupo_id
    WHERE ag.alumno_id = $1
  `, [alumnoId]);

  const gruposCount = Number(rG.rows[0]?.grupos_count || 0);
  const enV1 = !!Number(rG.rows[0]?.en_v1 || 0);
  const enV2 = !!Number(rG.rows[0]?.en_v2 || 0);

  if (gruposCount > 1) {
    if (enV1) return 'Violín I';
    if (enV2) return 'Violín II';
  }
  return null; // no cumple → dejamos el instrumento original del front
}
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
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_eventos', { title: 'Ayuda · Eventos', hero: false });
});
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
        END AS end_ts,
        NOT EXISTS (
          SELECT 1
          FROM evento_asignaciones ea
          WHERE ea.evento_id = e.id
        ) AS sin_configurar
      FROM eventos e
    )
    SELECT
      e2.id,
      e2.titulo,
      e2.descripcion,
      e2.grupo_id,
      e2.activo,
      e2.espacio_id,
      e2.sin_configurar,
      g.nombre  AS grupo_nombre,
      es.nombre AS espacio_nombre,
      to_char(e2.start_ts, 'YYYY-MM-DD"T"HH24:MI') AS start_iso,
      to_char(e2.end_ts,   'YYYY-MM-DD"T"HH24:MI') AS end_iso
    FROM e2
    LEFT JOIN grupos   g  ON g.id  = e2.grupo_id
    LEFT JOIN espacios es ON es.id = e2.espacio_id
  `;

  const cleanText = (s) => (s || '').toString().replace(/\s+/g,' ').trim();

  try {
    const { rows } = await db.query(sql);

    // Colores
    const NORMAL_BG = '#2a4b7c';
    const NORMAL_BR = '#2a4b7c';
    const NORMAL_TX = '#ffffff';

    const MUTED_BG  = '#cbd5e1';  // slate-300
    const MUTED_BR  = '#94a3b8';  // slate-400
    const MUTED_TX  = '#111827';  // gris oscuro p/contraste

    const eventos = rows.map(r => {
      const titulo = cleanText(r.titulo) || 'Evento sin título';
      const grupo  = cleanText(r.grupo_nombre || 'Sin grupo');

      const muted  = !!r.sin_configurar;

      // usa "color" que FullCalendar respeta en todas las vistas como bg+border
      const color  = muted ? MUTED_BG : NORMAL_BG;
      const bColor = muted ? MUTED_BR : NORMAL_BR;
      const tColor = muted ? MUTED_TX : NORMAL_TX;

      return {
        id: r.id,
        title: `${titulo} (${grupo})`,
        start: r.start_iso,
        end:   r.end_iso,
        allDay: false,                 // explícito por claridad

        // Props extra por si las necesitas en click/info
        titulo: titulo,
        descripcion: cleanText(r.descripcion || ''),
        grupo_id: r.grupo_id,
        grupo: grupo,
        espacio_id: r.espacio_id,
        espacio: cleanText(r.espacio_nombre || ''),
        activo: r.activo,
        sin_configurar: muted,

        // 🎨 Colores para FC
        color,                         // <- aplica fondo + borde
        textColor: tColor,
        backgroundColor: color,        // compat
        borderColor: bColor,           // compat

        // clase por si quieres añadir opacidad via CSS (opcional)
        classNames: muted ? ['sin-configurar'] : []
      };
    });

    res.json(eventos);
  } catch (err) {
    console.error('[eventos] GET /listado error:', err);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});
router.get('/', async (req, res) => {
    const desdeRaw = req.query.desde || '';
    const hastaRaw = req.query.hasta || '';
    const grupoRaw = req.query.grupo || 'todos';
  
    const desde = toISODate(desdeRaw);
    const hasta = toISODate(hastaRaw);
    const grupoId = /^\d+$/.test(String(grupoRaw)) ? Number(grupoRaw) : null;
  
    try {
      const { rows: grupos }   = await db.query('SELECT id, nombre FROM grupos   ORDER BY nombre');
      const { rows: espacios } = await db.query('SELECT id, nombre FROM espacios ORDER BY nombre');
  
      // Si hay rango => Vista LISTA
      if (desde && hasta) {
        const sql = `
          SELECT e.*, g.nombre AS grupo_nombre, es.nombre AS espacio_nombre
          FROM eventos e
          LEFT JOIN grupos   g  ON g.id  = e.grupo_id
          LEFT JOIN espacios es ON es.id = e.espacio_id
          WHERE to_date(left(e.fecha_inicio::text,10), 'YYYY-MM-DD') >= $1
            AND to_date(left(e.fecha_fin::text,10),   'YYYY-MM-DD') <= $2
            ${grupoId ? 'AND e.grupo_id = $3' : ''}
          ORDER BY e.fecha_inicio, e.hora_inicio NULLS FIRST
        `;
        const params = grupoId ? [desde, hasta, grupoId] : [desde, hasta];
        const { rows: eventos } = await db.query(sql, params);
  
        return res.render('eventos_lista', {
          title: 'Eventos',
          eventos,
          grupos,
          espacios,                 // 👈 necesario para los selects de espacio
          enLista: true,
          filtros: { desde, hasta, grupo: grupoId ? String(grupoId) : 'todos' }
        });
      }
  
      // Sin rango => Calendario
      return res.render('eventos_lista', {
        title: 'Eventos',
        eventos: null,
        grupos,
        espacios,                   // 👈 necesario para los modales
        filtros: null,
        enLista: false
      });
    } catch (error) {
      console.error('[eventos] GET / error:', error);
      res.status(500).send('Error al obtener eventos');
    }
});
router.get('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  
    const sql = `
      SELECT e.*, g.nombre AS grupo_nombre, es.nombre AS espacio_nombre
      FROM eventos e
      LEFT JOIN grupos   g  ON g.id  = e.grupo_id
      LEFT JOIN espacios es ON es.id = e.espacio_id
      WHERE e.id = $1
    `;
    try {
      const { rows } = await db.query(sql, [id]);
      if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
      const e = rows[0];
      res.json({
        id: e.id,
        titulo: cleanText(e.titulo),
        descripcion: cleanText(e.descripcion || ''),
        fecha_inicio: e.fecha_inicio,   // ya en ISO en BD
        fecha_fin:    e.fecha_fin,
        hora_inicio:  e.hora_inicio,
        hora_fin:     e.hora_fin,
        grupo_id:     e.grupo_id,
        grupo:        cleanText(e.grupo_nombre || ''),
        espacio_id:   e.espacio_id,     // 👈
        espacio:      cleanText(e.espacio_nombre || ''),
        activo:       e.activo
      });
    } catch (err) {
      console.error('[eventos] GET /:id error:', err);
      res.status(500).json({ error: 'Error al obtener evento' });
    }
});
router.post('/', async (req, res) => {
    const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo, espacio_id } = req.body;
  
    const activoValue = (String(activo) === '1' || activo === true);
    const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
    const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);
    if (!fIniISO || !fFinISO) return res.status(400).json({ error: 'Fechas inválidas' });
  
    const hora_inicio = hhmmOrNull(hiFromIni);
    const hora_fin    = hhmmOrNull(hfFromFin);
    const token = Math.random().toString(36).substring(2, 10);
  
    const sql = `
      INSERT INTO eventos (
        titulo, descripcion, fecha_inicio, fecha_fin, grupo_id,
        activo, hora_inicio, hora_fin, token, espacio_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
      token,
      (espacio_id ? Number(espacio_id) : null)
    ];
  
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(sql, params);
      const newId = rows[0].id;
  
      /*if (grupo_id) {
        await asignarAlumnosAEvento(db, newId, grupo_id, fIniISO);
      }*/
  
      await db.query('COMMIT');
      res.json({ id: newId });
    } catch (err) {
      await db.query('ROLLBACK');
      console.error('[eventos] POST / error:', err);
      res.status(500).json({ error: 'Error al guardar evento' });
    }
});
router.post('/masivo', async (req, res) => {
  try {
    const b = req.body || {};

    const titulo      = (b.titulo || '').trim();
    const descripcion = (b.descripcion || '').trim();
    const grupo_id    = Number(b.grupo_id) || null;
    const espacio_id  = (b.espacio_id === '' || b.espacio_id == null) ? null : Number(b.espacio_id);
    const activoVal   = (String(b.activo) === '1' || b.activo === 1 || b.activo === true);

    // Horas (formato "HH:MM")
    const hora_inicio = (b.hora_inicio || '').trim();
    const hora_fin    = (b.hora_fin    || '').trim();

    // Días (array de 'YYYY-MM-DD')
    const fechas = Array.isArray(b.fechas) ? b.fechas : [];

    // Validaciones
    if (!titulo)                   return res.status(400).send('Falta el título');
    if (!grupo_id)                 return res.status(400).send('Falta grupo_id');
    if (!/^\d{2}:\d{2}$/.test(hora_inicio)) return res.status(400).send('Hora inicio inválida (HH:MM)');
    if (!/^\d{2}:\d{2}$/.test(hora_fin))    return res.status(400).send('Hora fin inválida (HH:MM)');
    if (!fechas.length)            return res.status(400).send('Selecciona al menos un día');

    const validDays = fechas
      .map(d => String(d).trim())
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

    if (!validDays.length) return res.status(400).send('No hay días válidos');

    // Construcción de INSERT masivo
    // columnas: titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo, hora_inicio, hora_fin, token, espacio_id
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const rowsPlaceholders = [];
      const params = [];
      let i = 1;

      for (const day of validDays) {
        const token = Math.random().toString(36).slice(2, 10);
        rowsPlaceholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
        params.push(
          titulo || null,
          descripcion || null,
          day,                 // fecha_inicio (YYYY-MM-DD)
          day,                 // fecha_fin    (YYYY-MM-DD) -> mismo día
          grupo_id,
          activoVal,
          hora_inicio,         // TIME: lo castea PG
          hora_fin,            // TIME
          token,
          espacio_id || null
        );
      }

      const sql = `
        INSERT INTO eventos
          (titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo, hora_inicio, hora_fin, token, espacio_id)
        VALUES ${rowsPlaceholders.join(',')}
        RETURNING id
      `;

      const inserted = await client.query(sql, params);

      // Opcional: poblar asignaciones desde el grupo para cada evento creado
      for (const r of inserted.rows) {
        try {
          await asignarAlumnosAEvento(db, r.id, grupo_id);
        } catch (e) {
          // no aborta toda la tx por un fallo de poblar asignaciones
          console.warn('[masivo] fallo asignarAlumnosAEvento evento_id=', r.id, e);
        }
      }

      await client.query('COMMIT');
      return res.json({ ok: true, creados: inserted.rows.length, ids: inserted.rows.map(x => x.id) });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23503') { // FK (p.ej. espacio_id inexistente)
        return res.status(400).send('espacio_id no válido');
      }
      console.error('[eventos/masivo] TX error:', e);
      return res.status(500).send('Error al crear eventos (TX)');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[eventos] POST /masivo error:', err);
    res.status(500).send('Error al crear eventos');
  }
});
router.put('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  
    const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo, espacio_id } = req.body;
  
    const activoValue = (String(activo) === '1' || activo === true);
    const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
    const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);
    if (!fIniISO || !fFinISO) return res.status(400).json({ error: 'Fechas inválidas' });
  
    const hora_inicio = hhmmOrNull(hiFromIni);
    const hora_fin    = hhmmOrNull(hfFromFin);
  
    const sql = `
      UPDATE eventos
      SET titulo       = $1,
          descripcion  = $2,
          fecha_inicio = $3,
          fecha_fin    = $4,
          grupo_id     = $5,
          activo       = $6,
          hora_inicio  = $7,
          hora_fin     = $8,
          espacio_id   = $9
      WHERE id = $10
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
      (espacio_id ? Number(espacio_id) : null),
      id
    ];
  
    try {
      await db.query(sql, params);
      res.json({ updated: true });
    } catch (err) {
      console.error('[eventos] PUT /:id error:', err);
      res.status(500).json({ error: 'Error al actualizar evento' });
    }
});
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
    const hhmm = String(evento.hora_inicio || '00:00').slice(0, 5); // HH:MM
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
    CASE WHEN asi.alumno_id IS NOT NULL THEN TRUE ELSE FALSE END AS firmado,
    ea.hora_inicio,
    ea.hora_fin,
    ea.instrumento AS instrumento,
    ea.notas,
    ea.ausencia_tipo_id,
    au.tipo AS ausencia_tipo,
    ea.actividad_complementaria_id,
    ac.tipo AS actividad_complementaria
  FROM evento_asignaciones ea
  JOIN alumnos a ON a.id = ea.alumno_id
  LEFT JOIN asistencias asi
    ON asi.evento_id = ea.evento_id
   AND asi.alumno_id = ea.alumno_id
  LEFT JOIN ausencias au ON au.id = ea.ausencia_tipo_id
  LEFT JOIN actividades_complementarias ac ON ac.id = ea.actividad_complementaria_id
  LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
  LEFT JOIN instrumentos ins ON ins.id = ai.instrumento_id
  WHERE ea.evento_id = $1
  GROUP BY
    a.id, a.nombre, a.apellidos, a.dni, firmado,
    ea.hora_inicio, ea.hora_fin, ea.instrumento, ea.notas,
    ea.ausencia_tipo_id, au.tipo,
    ea.actividad_complementaria_id, ac.tipo
),
grupos_info AS (
  SELECT
    b.id AS alumno_id,
    COUNT(DISTINCT ag2.grupo_id) AS grupos_count,
    bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)')  AS en_violin_i,
    bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*(ii|2))(\\b|\\s|$)') AS en_violin_ii
  FROM base b
  LEFT JOIN alumno_grupo ag2 ON ag2.alumno_id = b.id
  LEFT JOIN grupos g2        ON g2.id = ag2.grupo_id
  GROUP BY b.id
),
etiquetado AS (
  SELECT
    b.*,
    CASE
      WHEN b.has_violin_puro
           AND gi.grupos_count > 1
           AND (gi.en_violin_i OR gi.en_violin_ii)
        THEN CASE WHEN gi.en_violin_i THEN 'Violín I' ELSE 'Violín II' END
      ELSE COALESCE(split_part(b.instrumentos, ', ', 1), '')
    END AS instrumento_mostrado
  FROM base b
  LEFT JOIN grupos_info gi ON gi.alumno_id = b.id
)
SELECT
  id, nombre, apellidos, dni,
  instrumentos,
  instrumento_mostrado,
  CASE
    WHEN LOWER(instrumento_mostrado) ~ '(viol[ií]n|viola|violonchelo|chelo|contrabajo)' THEN 'Cuerda'
    WHEN LOWER(instrumento_mostrado) ~ '(flauta|clarinete|oboe|fagot|saxof[oó]n|saxo)' THEN 'Viento madera'
    WHEN LOWER(instrumento_mostrado) ~ '(trompeta|tromb[oó]n|tuba|trompa|corneta)'     THEN 'Viento metal'
    WHEN LOWER(instrumento_mostrado) ~ '(percusi[oó]n|bater[ií]a|xil[oó]fono|timbales)' THEN 'Percusión'
    WHEN LOWER(instrumento_mostrado) ~ '(piano|teclado|clavec[ií]n|organo|[ó]rgano)'    THEN 'Teclado'
    WHEN LOWER(instrumento_mostrado) ~ '(guitarra|la[uú]d|bandurria|timple)'           THEN 'Cuerda pulsada'
    WHEN LOWER(instrumento_mostrado) ~ '(arpa)'                                         THEN 'Arpa'
    WHEN LOWER(instrumento_mostrado) ~ '(canto|voz|coral|coro)'                         THEN 'Voz'
    ELSE 'Otros'
  END AS familia_mostrada,
  firmado,
  hora_inicio, hora_fin, instrumento, notas,
  ausencia_tipo_id, ausencia_tipo,
  actividad_complementaria_id, actividad_complementaria
FROM etiquetado
ORDER BY apellidos NULLS LAST, nombre NULLS LAST, id;
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
router.get('/:id/firmas.pdf', async (req, res, next) => {
  try {
    const eventoId = Number(req.params.id);
    if (!Number.isInteger(eventoId)) return res.status(400).send('ID no válido');
    await pdfControlAsistencia(db, res, eventoId);
  } catch (err) {
    next(err);
  }
});
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
router.put('/:id/asignaciones/:alumnoId', async (req, res) => {
  const eventoId = Number(req.params.id);
  const alumnoId = Number(req.params.alumnoId);
  if (!Number.isInteger(eventoId) || !Number.isInteger(alumnoId)) {
    return res.status(400).json({ error: 'IDs inválidos' });
  }

  // Campos que podríamos aceptar del front
  const {
    hora_inicio,
    hora_fin,
    instrumento,                   // <- el importante
    notas,
    ausencia_tipo_id,
    actividad_complementaria_id
  } = req.body || {};

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Garantiza que exista la fila
    await client.query(
      `INSERT INTO evento_asignaciones (evento_id, alumno_id)
       VALUES ($1, $2)
       ON CONFLICT (evento_id, alumno_id) DO NOTHING`,
      [eventoId, alumnoId]
    );

    // 2) Construye UPDATE dinámico (solo setea lo que venga en el body)
    const sets = [];
    const params = [eventoId, alumnoId];
    let i = 3;

    // Importante: usamos hasOwnProperty para saber si el campo vino en el JSON,
    // aunque sea '' (string vacío). Así puedes borrar con "" -> NULLIF(...).
    if (Object.prototype.hasOwnProperty.call(req.body, 'hora_inicio')) {
      sets.push(`hora_inicio = $${i}::time`);
      params.push(hora_inicio || null);
      i++;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'hora_fin')) {
      sets.push(`hora_fin = $${i}::time`);
      params.push(hora_fin || null);
      i++;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'instrumento')) {
      // Guarda NULL si llega "" o solo espacios
      sets.push(`instrumento = NULLIF(btrim($${i}::text), '')`);
      params.push(instrumento ?? null);
      i++;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'notas')) {
      sets.push(`notas = $${i}::text`);
      params.push(notas ?? null);
      i++;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'ausencia_tipo_id')) {
      sets.push(`ausencia_tipo_id = $${i}::int`);
      params.push(ausencia_tipo_id ?? null);
      i++;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'actividad_complementaria_id')) {
      sets.push(`actividad_complementaria_id = $${i}::int`);
      params.push(actividad_complementaria_id ?? null);
      i++;
    }

    // Si no hay nada que actualizar, devolvemos la fila actual
    let row;
    if (sets.length) {
      const { rows } = await client.query(
        `UPDATE evento_asignaciones
           SET ${sets.join(', ')}
         WHERE evento_id = $1 AND alumno_id = $2
         RETURNING evento_id, alumno_id, hora_inicio, hora_fin, instrumento, notas, ausencia_tipo_id, actividad_complementaria_id`,
        params
      );
      row = rows[0];
    } else {
      const { rows } = await client.query(
        `SELECT evento_id, alumno_id, hora_inicio, hora_fin, instrumento, notas, ausencia_tipo_id, actividad_complementaria_id
           FROM evento_asignaciones
          WHERE evento_id = $1 AND alumno_id = $2`,
        [eventoId, alumnoId]
      );
      row = rows[0];
    }

    await client.query('COMMIT');
    return res.json(row || { ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT asignación:', err);
    return res.status(500).json({ error: 'Error guardando asignación' });
  } finally {
    client.release();
  }
});
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
router.delete('/:id/asignaciones/:alumnoId', async (req, res) => {
  const eventoId = Number(req.params.id);
  const alumnoId = Number(req.params.alumnoId);
  if (!Number.isInteger(eventoId) || !Number.isInteger(alumnoId)) {
    return res.status(400).json({ error: 'IDs inválidos' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2', [eventoId, alumnoId]);
    const r = await client.query(
      'DELETE FROM evento_asignaciones WHERE evento_id = $1 AND alumno_id = $2',
      [eventoId, alumnoId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, deleted: r.rowCount > 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE asignación:', err);
    res.status(500).json({ error: 'Error eliminando asignación' });
  } finally {
    client.release();
  }
});
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

      // NUEVO: si aplica, forzar a 'Violín I' / 'Violín II'
      const vi = await decideInstrumentoParaAlumno(client, { alumnoId });
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
router.get('/:id/instrumentos', async (req, res) => {
  const eventoId = Number(req.params.id);
  if (!Number.isInteger(eventoId)) return res.status(400).json({ error:'ID inválido' });

  // Reutilizamos la misma lógica de "instrumento_mostrado" de tu vista para que agrupen igual
  const sql = `
  WITH base AS (
    SELECT
      a.id AS alumno_id,
      ea.instrumento,               -- valor guardado por fila (puede ser null)
      ea.hora_inicio, ea.hora_fin,
      ea.ausencia_tipo_id, ea.actividad_complementaria_id,
      -- instrumentos del alumno (para fallback visual)
      string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,
      -- marca violín "puro"
      bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro,
      -- firmado
      CASE WHEN asi.alumno_id IS NOT NULL THEN TRUE ELSE FALSE END AS firmado
    FROM evento_asignaciones ea
    JOIN alumnos a ON a.id = ea.alumno_id
    LEFT JOIN asistencias asi
      ON asi.evento_id = ea.evento_id AND asi.alumno_id = ea.alumno_id
    LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
    LEFT JOIN instrumentos ins      ON ins.id = ai.instrumento_id
    WHERE ea.evento_id = $1
    GROUP BY a.id, ea.instrumento, ea.hora_inicio, ea.hora_fin,
             ea.ausencia_tipo_id, ea.actividad_complementaria_id, firmado
  ),
  grupos_info AS (
    SELECT
      b.alumno_id,
      COUNT(DISTINCT ag2.grupo_id) AS grupos_count,
      bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*i)(\\b|\\s|$)')                    AS en_violin_i,
      bool_or(LOWER(g2.nombre) ~ '(viol[ií]n\\s*(ii|2))(\\b|\\s|$)')               AS en_violin_ii
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
    LEFT JOIN grupos_info gi ON gi.alumno_id = b.alumno_id
  )
 SELECT
    e.instrumento_key,
    MIN(i.familia) AS familia,  -- ← añadido
    COUNT(*)::int                         AS total,
    SUM(CASE WHEN e.firmado THEN 1 ELSE 0 END)::int AS firmados,
    COUNT(DISTINCT e.ausencia_tipo_id)::int AS ausencias_distintas,
    COUNT(DISTINCT e.actividad_complementaria_id)::int AS actividades_distintas,
    MIN(e.hora_inicio) AS min_inicio,
    MAX(e.hora_fin)    AS max_fin
    FROM etiquetado e
    LEFT JOIN instrumentos i
      ON lower(btrim(i.nombre)) = lower(btrim(e.instrumento_key))  -- normalizado
    GROUP BY e.instrumento_key
    ORDER BY e.instrumento_key NULLS FIRST;
  `;
  try {
    const { rows } = await db.query(sql, [eventoId]);
    res.json(rows);
  } catch (err) {
    console.error('GET instrumentos:', err);
    res.status(500).json({ error: 'Error obteniendo instrumentos' });
  }
});
router.put('/:id/instrumentos', async (req, res) => {
  const eventoId = Number(req.params.id);
  const { instrumento_key, acciones } = req.body || {};
  if (!Number.isInteger(eventoId) || typeof instrumento_key !== 'string' || !acciones) {
    return res.status(400).json({ ok:false, error:'Petición inválida' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Seleccionar alumnos objetivo en _tgt (misma lógica de etiquetado que la vista)
    await client.query(`CREATE TEMP TABLE _tgt (alumno_id int PRIMARY KEY) ON COMMIT DROP;`);
    const selSQL = `
      WITH base AS (
        SELECT
          a.id AS alumno_id,
          ea.instrumento,
          string_agg(DISTINCT ins.nombre, ', ' ORDER BY ins.nombre) AS instrumentos,
          bool_or(ins.nombre ~* '^\\s*viol(í|i)n\\s*$') AS has_violin_puro
        FROM evento_asignaciones ea
        JOIN alumnos a ON a.id = ea.alumno_id
        LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
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
      )
      INSERT INTO _tgt(alumno_id)
      SELECT e.alumno_id
      FROM etiquetado e
      WHERE e.instrumento_key = $2;
    `;
    await client.query(selSQL, [eventoId, instrumento_key]);

    let afectados = 0;

    // 2) Acciones

    // set_time {inicio, fin} -> $2 (NO $3)
    if (acciones.set_time) {
      const { inicio, fin } = acciones.set_time;

      if (typeof inicio === 'string' && /^\d{2}:\d{2}$/.test(inicio)) {
        const r1 = await client.query(`
          UPDATE evento_asignaciones ea
          SET hora_inicio = $2::time
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, inicio]);
        afectados += r1.rowCount || 0;
      }
      if (typeof fin === 'string' && /^\d{2}:\d{2}$/.test(fin)) {
        const r2 = await client.query(`
          UPDATE evento_asignaciones ea
          SET hora_fin = $2::time
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, fin]);
        afectados += r2.rowCount || 0;
      }
    }

    // shift_minutes -> $2 (NO $3)
    if (Number.isFinite(acciones.shift_minutes) && acciones.shift_minutes !== 0) {
      const m = Number(acciones.shift_minutes);
      const r = await client.query(`
        UPDATE evento_asignaciones ea
        SET hora_inicio = CASE WHEN hora_inicio IS NULL THEN NULL ELSE (hora_inicio + make_interval(mins => $2)) END,
            hora_fin    = CASE WHEN hora_fin    IS NULL THEN NULL ELSE (hora_fin    + make_interval(mins => $2)) END
        FROM _tgt t
        WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
      `, [eventoId, m]);
      afectados += r.rowCount || 0;
    }

    // set { ausencia_tipo_id, actividad_complementaria_id, instrumento, notas_mode, notas_text }
    if (acciones.set) {
      if ('ausencia_tipo_id' in acciones.set) {
        const v = acciones.set.ausencia_tipo_id ?? null;
        const r = await client.query(`
          UPDATE evento_asignaciones ea
          SET ausencia_tipo_id = $2
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, v]);
        afectados += r.rowCount || 0;
      }
      if ('actividad_complementaria_id' in acciones.set) {
        const v = acciones.set.actividad_complementaria_id ?? null;
        const r = await client.query(`
          UPDATE evento_asignaciones ea
          SET actividad_complementaria_id = $2
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, v]);
        afectados += r.rowCount || 0;
      }
      if (typeof acciones.set.instrumento === 'string') {
        const v = acciones.set.instrumento || null;
        const r = await client.query(`
          UPDATE evento_asignaciones ea
          SET instrumento = $2
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, v]);
        afectados += r.rowCount || 0;
      }
      if (typeof acciones.set.notas_mode === 'string' && typeof acciones.set.notas_text === 'string') {
        const mode = acciones.set.notas_mode;
        const text = acciones.set.notas_text;
        let expr = '$2';
        if (mode === 'append')  expr = `COALESCE(ea.notas,'') || $2`;
        if (mode === 'prepend') expr = `$2 || COALESCE(ea.notas,'')`;
        const r = await client.query(`
          UPDATE evento_asignaciones ea
          SET notas = ${expr}
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId, text]);
        afectados += r.rowCount || 0;
      }
    }

    // sign true/false
    if ('sign' in acciones) {
      if (acciones.sign === true) {
        await client.query(`
          INSERT INTO asistencias (evento_id, alumno_id)
          SELECT $1, alumno_id FROM _tgt
          ON CONFLICT DO NOTHING
        `, [eventoId]);
        await client.query(`
          UPDATE evento_asignaciones ea
          SET ausencia_tipo_id = NULL
          FROM _tgt t
          WHERE ea.evento_id = $1 AND ea.alumno_id = t.alumno_id
        `, [eventoId]);
      } else if (acciones.sign === false) {
        await client.query(`
          DELETE FROM asistencias s
          USING _tgt t
          WHERE s.evento_id = $1 AND s.alumno_id = t.alumno_id
        `, [eventoId]);
      }
    }

    await client.query('COMMIT');
    return res.json({ ok:true, afectados });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /:id/instrumentos', err);
    return res.status(500).json({ ok:false, error:'Error aplicando cambios por instrumento' });
  } finally {
    client.release();
  }
});
router.delete('/:id/instrumentos', async (req, res) => {
  const eventoId = Number(req.params.id);
  const { instrumento_key } = req.body || {};
  if (!Number.isInteger(eventoId) || typeof instrumento_key !== 'string') {
    return res.status(400).json({ ok:false, error:'Petición inválida' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`CREATE TEMP TABLE _tgt (alumno_id int PRIMARY KEY) ON COMMIT DROP;`);
    const selSQL = `
      WITH base AS (
        SELECT
          a.id AS alumno_id,
          ea.instrumento,
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
      )
      INSERT INTO _tgt(alumno_id)
      SELECT e.alumno_id
      FROM etiquetado e
      WHERE e.instrumento_key = $2;
    `;
    await client.query(selSQL, [eventoId, instrumento_key]);

    // borrar asistencias primero
    await client.query(`
      DELETE FROM asistencias s
      USING _tgt t
      WHERE s.evento_id=$1 AND s.alumno_id=t.alumno_id
    `, [eventoId]);

    // borrar asignaciones
    const r = await client.query(`
      DELETE FROM evento_asignaciones ea
      USING _tgt t
      WHERE ea.evento_id=$1 AND ea.alumno_id=t.alumno_id
    `, [eventoId]);

    await client.query('COMMIT');
    return res.json({ ok:true, eliminados: r.rowCount || 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /:id/instrumentos', err);
    return res.status(500).json({ ok:false, error:'Error eliminando por instrumento' });
  } finally {
    client.release();
  }
});
router.get('/:id/familias', async (req, res) => {
  const eventoId = Number(req.params.id);
  if (!Number.isInteger(eventoId)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  const sql = `
    WITH asig AS (
      SELECT
        ea.alumno_id,
        ea.hora_inicio,
        ea.hora_fin,
        NULLIF(ea.instrumento, '') AS instrumento_key
      FROM evento_asignaciones ea
      WHERE ea.evento_id = $1
    ),
    fam_res AS (
      SELECT
        a.alumno_id,
        a.hora_inicio,
        a.hora_fin,
        COALESCE(ins.familia, i1.familia) AS familia_final
      FROM asig a
      -- 1) Si ea.instrumento tiene valor, mapeamos por nombre a instrumentos.familia
      LEFT JOIN instrumentos ins
             ON ins.nombre = a.instrumento_key
      -- 2) Si no, tomamos el primer instrumento del alumno
      LEFT JOIN LATERAL (
        SELECT i.familia
        FROM alumno_instrumento ai
        JOIN instrumentos i ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = a.alumno_id
        ORDER BY i.nombre
        LIMIT 1
      ) AS i1 ON TRUE
    )
    SELECT
      familia_final AS familia_key,
      MIN(hora_inicio) AS min_inicio,
      MAX(hora_fin)    AS max_fin
    FROM fam_res
    WHERE NULLIF(TRIM(familia_final), '') IS NOT NULL
    GROUP BY familia_final
    ORDER BY familia_final;
  `;

  try {
    const { rows } = await db.query(sql, [eventoId]);
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    console.error('GET familias (por instrumentos):', err);
    return res.status(500).json({ error: 'Error obteniendo familias' });
  }
});
router.put('/:id/familias', async (req, res) => {
  const eventoId = Number(req.params.id);
  if (!Number.isInteger(eventoId)) {
    return res.status(400).json({ error: 'Evento inválido' });
  }

  const { familia_key, acciones } = req.body || {};
  if (typeof familia_key !== 'string' || !familia_key.trim()) {
    return res.status(400).json({ error: 'familia_key requerido' });
  }

  // Construye SET dinámico
  const setClauses = [];
  const params = [eventoId];
  let i = 2;

  if (acciones?.set_time) {
    if (acciones.set_time.inicio) { setClauses.push(`hora_inicio = $${i++}`); params.push(acciones.set_time.inicio); }
    if (acciones.set_time.fin)    { setClauses.push(`hora_fin    = $${i++}`); params.push(acciones.set_time.fin); }
  }
  if (acciones?.set) {
    if (Object.prototype.hasOwnProperty.call(acciones.set, 'ausencia_tipo_id')) {
      setClauses.push(`ausencia_tipo_id = $${i++}`); params.push(acciones.set.ausencia_tipo_id ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(acciones.set, 'actividad_complementaria_id')) {
      setClauses.push(`actividad_complementaria_id = $${i++}`); params.push(acciones.set.actividad_complementaria_id ?? null);
    }
    if (acciones.set.notas_mode === 'replace') {
      setClauses.push(`notas = $${i++}`); params.push(acciones.set.notas_text ?? '');
    }
  }

  if (!setClauses.length) return res.status(400).json({ error:'Nada que actualizar' });

  // Familia resuelta: por ea.instrumento -> instrumentos.familia; si no hay, primer instrumento del alumno
  const sql = `
    WITH base AS (
      SELECT ea.*
      FROM evento_asignaciones ea
      WHERE ea.evento_id = $1
    ),
    fam_res AS (
      SELECT
        b.alumno_id,
        COALESCE(i2.familia, i1.familia) AS familia_final
      FROM base b
      LEFT JOIN instrumentos i2
             ON i2.nombre = NULLIF(b.instrumento,'')
      LEFT JOIN LATERAL (
        SELECT i.familia
        FROM alumno_instrumento ai
        JOIN instrumentos i ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = b.alumno_id
        ORDER BY i.nombre
        LIMIT 1
      ) AS i1 ON TRUE
    )
    UPDATE evento_asignaciones ea
    SET ${setClauses.join(', ')}
    FROM fam_res fr
    WHERE ea.evento_id = $1
      AND ea.alumno_id = fr.alumno_id
      AND fr.familia_final = $${i}
    RETURNING ea.alumno_id;
  `;
  params.push(familia_key);

  try {
    const { rows } = await db.query(sql, params);
    res.json({ ok:true, updated: rows.length });
  } catch (err) {
    console.error('PUT familias:', err);
    res.status(500).json({ ok:false, error:'Error actualizando por familia' });
  }
});
router.delete('/:id/familias', async (req, res) => {
  const eventoId = Number(req.params.id);
  const { familia_key } = req.body || {};
  if (!Number.isInteger(eventoId) || !familia_key || typeof familia_key !== 'string') {
    return res.status(400).json({ ok:false, error:'Petición inválida' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Alumnos objetivo:
    //    - Coinciden por nombre de instrumento escrito en la asignación (normalizado)
    //      con un instrumento de esa familia
    //    - O bien, aunque la asignación no tenga nombre fiable, el alumno toca
    //      *algún* instrumento de esa familia (alumno_instrumento → instrumentos.familia)
    const selIdsSql = `
      WITH cand AS (
        SELECT DISTINCT ea.alumno_id
        FROM evento_asignaciones ea
        LEFT JOIN instrumentos ix
               ON lower(btrim(ix.nombre)) = lower(btrim(ea.instrumento))
        WHERE ea.evento_id = $1
          AND (
            (ix.familia = $2)
            OR EXISTS (
              SELECT 1
              FROM alumno_instrumento ai
              JOIN instrumentos i2 ON i2.id = ai.instrumento_id
              WHERE ai.alumno_id = ea.alumno_id
                AND i2.familia = $2
            )
          )
      )
      SELECT COALESCE(array_agg(alumno_id), '{}') AS ids
      FROM cand;
    `;
    const { rows } = await client.query(selIdsSql, [eventoId, familia_key]);
    const ids = rows[0]?.ids || [];

    if (ids.length === 0) {
      await client.query('COMMIT');
      return res.json({ ok:true, eliminados: 0, alumnos: [] });
    }

    // 2) Borrar asistencias de esos alumnos en el evento
    await client.query(
      `DELETE FROM asistencias
        WHERE evento_id = $1 AND alumno_id = ANY($2::int[])`,
      [eventoId, ids]
    );

    // 3) Borrar asignaciones de esos alumnos en el evento
    const delAsign = await client.query(
      `DELETE FROM evento_asignaciones
        WHERE evento_id = $1 AND alumno_id = ANY($2::int[])`,
      [eventoId, ids]
    );

    await client.query('COMMIT');
    return res.json({ ok:true, eliminados: delAsign.rowCount || 0, alumnos: ids });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE familias (robusto+EXISTS):', err);
    return res.status(500).json({ ok:false, error:'Error eliminando por familia' });
  } finally {
    client.release();
  }
});
module.exports = router;

