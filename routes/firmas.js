// routes/firmas.js (SERVIDOR)
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const bcrypt  = require('bcrypt');

/* -------------------------------- PÁGINAS -------------------------------- */
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_firmas', { title: 'Ayuda · Alumnos', hero: false });
});

/* ------------------------------- REGISTRO APP ---------------------------- */
router.post('/registro-app', async (req, res) => {
  const { email, dni, password } = req.body;
  try {
    const r = await db.query('SELECT * FROM alumnos WHERE email = $1 AND dni = $2', [email, dni]);
    const alumno = r.rows[0];
    if (!alumno) return res.status(404).json({ error: 'No existe un alumno con ese email y DNI' });
    if (alumno.registrado) return res.status(400).json({ error: 'Este alumno ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE alumnos SET password = $1, registrado = $2 WHERE id = $3', [hash, true, alumno.id]);
    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('registro-app:', err);
    res.status(500).json({ error: 'Error al registrar al alumno' });
  }
});

/* ---------------------------------- LOGIN -------------------------------- */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await db.query('SELECT * FROM alumnos WHERE email = $1 AND registrado = true', [email]);
    const alumno = r.rows[0];
    if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado o no registrado' });

    const ok = await bcrypt.compare(password, alumno.password);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ error: 'Error en la base de datos' });
  }
});

/* ------------------------------ FIRMA POR QR ----------------------------- */
async function handleFirmarQR(req, res) {
  try {
    const raw = req.body || {};
    const alumno_id = Number(raw.alumno_id);
    const evento_id = Number(raw.evento_id);
    const token     = raw.token != null ? String(raw.token) : null;
    const ubicacion = (raw.ubicacion != null && raw.ubicacion !== '') ? String(raw.ubicacion) : null;

    if (!alumno_id || !evento_id || !token) {
      return res.status(400).json({ success: false, mensaje: 'Faltan datos (alumno_id, evento_id, token)' });
    }

    // validar evento + token
    const ev = await db.query(
      `SELECT id FROM eventos
        WHERE id = $1::int
          AND token = $2::text
          AND activo IS TRUE`,
      [evento_id, token]
    );
    if (ev.rowCount === 0) {
      return res.status(400).json({ success: false, mensaje: 'Evento no válido o inactivo' });
    }

    // upsert idempotente
    const nowMadrid = " (now() at time zone 'Europe/Madrid') ";
    const upsert = await db.query(
      `INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo, ubicacion)
       VALUES ($1::int, $2::int, (${nowMadrid})::date, (${nowMadrid})::time, 'qr', $3::text)
       ON CONFLICT ON CONSTRAINT asistencias_alumno_evento_uniq DO NOTHING
       RETURNING id`,
      [alumno_id, evento_id, ubicacion]
    );

    if (upsert.rowCount === 0) {
      return res.json({ success: true, yaFirmado: true, mensaje: 'Asistencia ya estaba registrada para este evento' });
    }
    return res.json({ success: true, yaFirmado: false, mensaje: 'Asistencia registrada correctamente' });
  } catch (err) {
    console.error('firmar-qr:', err);
    return res.status(500).json({ success: false, mensaje: 'Error interno' });
  }
}
router.post('/firmar-qr', handleFirmarQR);
router.post('/',        handleFirmarQR); // alias histórico

/* ------------------------- HELPERS + TABLA ASIGN. ------------------------ */
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

let _asignTable = null;
async function getAsignTable() {
  if (_asignTable) return _asignTable;
  for (const name of ['evento_asignaciones', 'eventos_asignaciones']) {
    const { rows } = await db.query(`SELECT to_regclass('public.${name}') AS t`);
    if (rows[0]?.t) { _asignTable = name; break; }
  }
  if (!_asignTable) throw new Error('No se encontró la tabla de asignaciones (evento[s]_asignaciones).');
  return _asignTable;
}

/* =============================== API ALUMNO ============================== */
/** 1) Eventos del alumno (calendario) */
router.get('/api/alumno/:alumnoId/eventos', async (req, res) => {
  const alumnoId = toInt(req.params.alumnoId);
  if (!alumnoId) return res.status(400).json({ error: 'alumnoId inválido' });

  try {
    const asignTable = await getAsignTable();
    const sql = `
      WITH base AS (
        SELECT e.id, e.titulo, e.descripcion, e.grupo_id, e.espacio_id,
               e.fecha_inicio::text AS fi, e.fecha_fin::text AS ff,
               e.hora_inicio, e.hora_fin,
               a.hora_inicio AS ahi, a.hora_fin AS ahf
          FROM ${asignTable} a
          JOIN eventos e ON e.id = a.evento_id
         WHERE a.alumno_id = $1
      ),
      t AS (
        SELECT b.*,
               to_char(
                 to_timestamp(left(b.fi,10) || ' ' ||
                   COALESCE(NULLIF(b.ahi::text,''), NULLIF(b.hora_inicio::text,''), '00:00'), 'YYYY-MM-DD HH24:MI'
                 ),
                 'YYYY-MM-DD"T"HH24:MI'
               ) AS start_iso,
               to_char(
                 to_timestamp(left(b.ff,10) || ' ' ||
                   COALESCE(NULLIF(b.ahf::text,''), NULLIF(b.hora_fin::text,''), COALESCE(NULLIF(b.ahi::text,''), NULLIF(b.hora_inicio::text,''), '00:00')), 'YYYY-MM-DD HH24:MI'
                 ),
                 'YYYY-MM-DD"T"HH24:MI'
               ) AS end_iso
          FROM base b
      )
      SELECT t.id, t.titulo, t.descripcion, t.start_iso, t.end_iso,
             g.nombre AS grupo_nombre, es.nombre AS espacio_nombre
        FROM t
        LEFT JOIN grupos   g  ON g.id  = t.grupo_id
        LEFT JOIN espacios es ON es.id = t.espacio_id
       ORDER BY t.start_iso;
    `;
    const { rows } = await db.query(sql, [alumnoId]);
    res.json(rows.map(r => ({
      id: r.id,
      title: r.titulo || 'Evento',
      start: r.start_iso,
      end:   r.end_iso,
      extendedProps: {
        descripcion: r.descripcion || '',
        grupo: r.grupo_nombre || '',
        espacio: r.espacio_nombre || ''
      }
    })));
  } catch (err) {
    console.error('[firmas/api] eventos alumno:', err);
    res.status(500).json({ error: 'Error obteniendo eventos' });
  }
});

/** 2) Detalle de evento del alumno */
router.get('/api/alumno/:alumnoId/eventos/:eventoId', async (req, res) => {
  const alumnoId = toInt(req.params.alumnoId);
  const eventoId = toInt(req.params.eventoId);
  if (!alumnoId || !eventoId) return res.status(400).json({ error: 'IDs inválidos' });

  try {
    const asignTable = await getAsignTable();
    const sql = `
      SELECT e.id, e.titulo, e.descripcion,
             e.fecha_inicio::text AS fecha_inicio,
             e.fecha_fin::text    AS fecha_fin,
             e.hora_inicio, e.hora_fin,
             g.nombre  AS grupo,
             es.nombre AS espacio,
             a.hora_inicio AS hora_asignada_inicio,
             a.hora_fin    AS hora_asignada_fin
        FROM eventos e
        JOIN ${asignTable} a ON a.evento_id = e.id AND a.alumno_id = $1
        LEFT JOIN grupos   g  ON g.id  = e.grupo_id
        LEFT JOIN espacios es ON es.id = e.espacio_id
       WHERE e.id = $2
       LIMIT 1;
    `;
    const { rows } = await db.query(sql, [alumnoId, eventoId]);
    if (!rows.length) return res.status(404).json({ error: 'No convocado a este evento' });

    const r = rows[0];
    res.json({
      id: r.id,
      titulo: r.titulo || 'Evento',
      descripcion: r.descripcion || '',
      grupo: r.grupo || '',
      espacio: r.espacio || '',
      fecha_inicio: r.fecha_inicio?.slice(0,10) || null,
      fecha_fin:    r.fecha_fin?.slice(0,10)    || null,
      hora_inicio:  (r.hora_asignada_inicio || r.hora_inicio || '')?.toString().slice(0,5) || null,
      hora_fin:     (r.hora_asignada_fin    || r.hora_fin    || '')?.toString().slice(0,5) || null
    });
  } catch (err) {
    console.error('[firmas/api] evento detalle:', err);
    res.status(500).json({ error: 'Error obteniendo detalle del evento' });
  }
});

/** 3) Partituras por grupos del alumno */
router.get('/api/alumno/:alumnoId/partituras', async (req, res) => {
  const alumnoId = toInt(req.params.alumnoId);
  if (!alumnoId) return res.status(400).json({ error: 'alumnoId inválido' });

  const sql = `
    SELECT p.id, p.titulo, p.autor, p.arreglista,
           p.enlace_partitura, p.enlace_audio,
           p.descripcion, p.genero, p.duracion, p.tags,
           g.nombre AS grupo
      FROM partituras p
      JOIN grupos g ON g.id = p.grupo_id
     WHERE p.grupo_id IN (SELECT ag.grupo_id FROM alumno_grupo ag WHERE ag.alumno_id = $1)
       AND COALESCE(p.activo, TRUE) IS TRUE
     ORDER BY p.updated_at DESC NULLS LAST, p.id DESC;
  `;
  try {
    const { rows } = await db.query(sql, [alumnoId]);
    res.json(rows);
  } catch (err) {
    console.error('[firmas/api] partituras alumno:', err);
    res.status(500).json({ error: 'Error obteniendo partituras' });
  }
});

module.exports = router;

