// routes/firmas.js (SERVIDOR) — versión JWT (sin cookies/sesión)
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

// === Utilidades ===
async function ensureReadColumn(client, table){
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS leido_at TIMESTAMP NULL`);
}

const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

// === Middleware JWT ===
function requireJWT(req, res, next){
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ success:false, error:'auth_required' });
  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    req.alumno_id = Number(payload.sub || 0);
    req.jwt = payload; // opcional: por si quieres usar nombre/email/rol
    if (!req.alumno_id) throw new Error('invalid_sub');
    next();
  } catch (e) {
    return res.status(401).json({ success:false, error:'invalid_token' });
  }
}

// === Helper: comprobar que el :alumnoId del path coincide con el token ===
function mustMatchAlumnoParam(req, res, next){
  const urlId = toInt(req.params.alumnoId);
  if (!urlId) return res.status(400).json({ error: 'alumnoId inválido' });
  if (urlId !== Number(req.alumno_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

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
    await db.query(
      'UPDATE alumnos SET password = $1, registrado = $2 WHERE id = $3',
      [hash, true, alumno.id]
    );
    // Devuelve datos mínimos. (El token se emite en /login)
    res.json({ success: true, alumno_id: alumno.id, nombre: alumno.nombre });
    
  } catch (err) {
    console.error('registro-app:', err);
    res.status(500).json({ error: 'Error al registrar al alumno' });
  }
});

/* ---------------------------------- LOGIN -------------------------------- */
// Login alumno (JOSG en tu mano) — emite JWT
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    // normaliza el email por si viene con mayúsculas/espacios
    const r = await db.query(
      'SELECT * FROM alumnos WHERE lower(email) = lower($1) AND registrado = true LIMIT 1',
      [String(email || '').trim()]
    );
    const alumno = r.rows[0];
    if (!alumno) return res.status(404).json({ success:false, error: 'Alumno no encontrado o no registrado' });

    const ok = await bcrypt.compare(password || '', alumno.password);
    if (!ok) return res.status(401).json({ success:false, error: 'Contraseña incorrecta' });

    // === JWT ===
    const token = jwt.sign(
      { sub: alumno.id, rol: 'alumno', email: alumno.email || null, nombre: alumno.nombre || '' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '7d' }
    );

    // devuelve también el nombre (y, si te sirve, el email)
    return res.json({
      success: true,
      token,
      alumno_id: alumno.id,
      nombre: alumno.nombre || '',
      email: alumno.email || null
    });
  } catch (err) {
    console.error('login:', err);
    return res.status(500).json({ success:false, error: 'Error en la base de datos' });
  }
});

/* ------------------------------ FIRMA POR QR ----------------------------- */
// Protegido por JWT; toma el alumno_id del token (no del body)
async function handleFirmarQR(req, res) {
  try {
    const raw = req.body || {};
    const alumno_id = Number(req.alumno_id || 0);
    const evento_id = Number(raw.evento_id);
    const tokenQR   = raw.token != null ? String(raw.token) : null;
    const ubicacion = (raw.ubicacion != null && raw.ubicacion !== '') ? String(raw.ubicacion) : null;

    if (!alumno_id || !evento_id || !tokenQR) {
      return res.status(400).json({ success: false, mensaje: 'Faltan datos (evento_id, token)' });
    }

    // validar evento + token
    const ev = await db.query(
      `SELECT id FROM eventos
        WHERE id = $1::int
          AND token = $2::text
          AND activo IS TRUE`,
      [evento_id, tokenQR]
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
router.post('/firmar-qr', requireJWT, handleFirmarQR);
router.post('/',        requireJWT, handleFirmarQR); // alias histórico

/* ------------------------- HELPERS + TABLA ASIGN. ------------------------ */

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
// Todas las rutas /api/* requieren JWT
router.use('/api', requireJWT);

/** 1) Eventos del alumno (calendario) */
router.get('/api/alumno/:alumnoId/eventos', mustMatchAlumnoParam, async (req, res) => {
  const alumnoId = Number(req.alumno_id);

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
       g.nombre AS grupo_nombre, es.nombre AS espacio_nombre,
       es.ubicacion AS espacio_ubicacion
        FROM t
        LEFT JOIN grupos   g  ON g.id  = t.grupo_id
        LEFT JOIN espacios es ON es.id = t.espacio_id
       ORDER BY t.start_iso;
    `;
    const { rows } = await db.query(sql, [alumnoId]);

    res.json(rows.map(r => {
      const ubic = (r.espacio_ubicacion || '').trim();
      const espacio_link = ubic ? `https://www.google.com/maps?q=${encodeURIComponent(ubic)}` : null;

      return {
        id: r.id,
        title: r.titulo || 'Evento',
        start: r.start_iso,
        end:   r.end_iso,
        extendedProps: {
          descripcion: r.descripcion || '',
          grupo: r.grupo_nombre || '',
          espacio: r.espacio_nombre || '',
          espacio_ubicacion: ubic,
          espacio_link
        }
      };
    }));
  } catch (err) {
    console.error('[firmas/api] eventos alumno:', err);
    res.status(500).json({ error: 'Error obteniendo eventos' });
  }
});

/** 2) Detalle de evento del alumno */
router.get('/api/alumno/:alumnoId/eventos/:eventoId', mustMatchAlumnoParam, async (req, res) => {
  const alumnoId = Number(req.alumno_id);
  const eventoId = toInt(req.params.eventoId);
  if (!eventoId) return res.status(400).json({ error: 'eventoId inválido' });

  try {
    const asignTable = await getAsignTable();
    const sql = `
      SELECT e.id, e.titulo, e.descripcion,
             e.fecha_inicio::text AS fecha_inicio,
             e.fecha_fin::text    AS fecha_fin,
             e.hora_inicio, e.hora_fin,
             g.nombre  AS grupo,
             es.nombre AS espacio,
             es.ubicacion AS espacio_ubicacion, 
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
      espacio_ubicacion: (r.espacio_ubicacion || '').trim(),
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
router.get('/api/alumno/:alumnoId/partituras', mustMatchAlumnoParam, async (req, res) => {
  const alumnoId = Number(req.alumno_id);

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

// ─────────────────────── Alumno básico por id (para mostrar nombre) ─────────────
router.get('/api/alumno/:alumnoId/basico', mustMatchAlumnoParam, async (req, res) => {
  const id = Number(req.alumno_id);
  try {
    const { rows } = await db.query('SELECT nombre FROM alumnos WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error:'Alumno no encontrado' });
    res.json({ success:true, nombre: rows[0].nombre });
  } catch (err) {
    res.status(500).json({ error:'Error en DB' });
  }
});

// ================= MENSAJES (lectura alumno) =================

async function detectMsgSchema(client){
  // tablas posibles de destinatarios
  const t = await client.query(`
    SELECT lower(table_name) AS t
    FROM information_schema.tables
    WHERE table_schema='public'
      AND lower(table_name) IN (
        'mensajes',
        'mensaje_entrega',
        'mensaje_destino',
        'mensaje_destinatarios',
        'mensajes_destinatarios',
        'mensajes_alumnos'
      )
  `);
  const names = new Set(t.rows.map(r=>r.t));
  if (!names.has('mensajes')) return null;

  // columnas de mensajes
  const colsMsg = await client.query(`
    SELECT lower(column_name) AS c
    FROM information_schema.columns WHERE table_name='mensajes'
  `);
  const M = new Set(colsMsg.rows.map(r=>r.c));

  // prioridad: 1) mensaje_entrega, 2) mensaje_destino, 3) variantes antiguas
  const destTable =
    names.has('mensaje_entrega')        ? 'mensaje_entrega'        :
    names.has('mensaje_destino')        ? 'mensaje_destino'        :
    names.has('mensaje_destinatarios')  ? 'mensaje_destinatarios'  :
    names.has('mensajes_destinatarios') ? 'mensajes_destinatarios' :
    names.has('mensajes_alumnos')       ? 'mensajes_alumnos'       : null;

  if (!destTable) return { mensajes:true, dest:null, M, dcols:new Set(), msgCol:null, alumCol:null, grpCol:null };

  const colsDest = await client.query(
    `SELECT lower(column_name) AS c FROM information_schema.columns WHERE table_name=$1`,
    [destTable]
  );
  const D = new Set(colsDest.rows.map(r=>r.c));

  const msgCol  = D.has('mensaje_id')  ? 'mensaje_id'
                : D.has('mensajes_id') ? 'mensajes_id'
                : D.has('id_mensaje')  ? 'id_mensaje'
                : null;

  const alumCol = D.has('alumno_id')   ? 'alumno_id'
                : D.has('alumnos_id')  ? 'alumnos_id'
                : D.has('id_alumno')   ? 'id_alumno'
                : null;

  const grpCol  = D.has('grupo_id')    ? 'grupo_id' : null; // sólo en mensaje_destino

  return { mensajes:true, dest:destTable, M, dcols:D, msgCol, alumCol, grpCol };
}

// GET /firmas/api/alumno/:alumnoId/mensajes
router.get('/api/alumno/:alumnoId/mensajes', mustMatchAlumnoParam, async (req,res)=>{
  const alumnoId = Number(req.alumno_id);

  const client = await db.connect();
  try {
    const sch = await detectMsgSchema(client);
    if (!sch || !sch.dest || !sch.msgCol || !sch.alumCol) return res.json([]);

    // columnas opcionales en 'mensajes'
    const hasTitulo = sch.M.has('titulo') || sch.M.has('title') || sch.M.has('nombre');
    const selTitulo = sch.M.has('titulo') ? 'm.titulo'
                  : sch.M.has('title')    ? 'm.title'
                  : sch.M.has('nombre')   ? 'm.nombre'
                  : `'Aviso'`;

    const selUrl   = sch.M.has('url')  ? 'm.url'  : 'NULL';
    // NORMALIZA urls a JSON array
    const selUrls  = sch.M.has('urls')
      ? `COALESCE(NULLIF(m.urls::text,'')::jsonb,'[]'::jsonb)`
      : `'[]'::jsonb`;

    const createdExpr =
      sch.M.has('created_at') ? 'm.created_at'
    : sch.M.has('fecha')      ? 'm.fecha'
    : sch.M.has('ts')         ? 'm.ts'
    : 'NULL::timestamp';

    // autor si existe (usuario_id / creado_por / autor_id)
    const joinAutor = sch.M.has('usuario_id') ? 'm.usuario_id'
                    : sch.M.has('creado_por') ? 'm.creado_por'
                    : sch.M.has('autor_id')   ? 'm.autor_id'
                    : null;

    const selAutor  = joinAutor
      ? `COALESCE(NULLIF(TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellidos,'')),''),
                  u.email,'')`
      : 'NULL';

    const leftJoinU = joinAutor ? `LEFT JOIN usuarios u ON u.id = ${joinAutor}` : '';

    const selLeido  = sch.dcols.has('leido_at') ? 'd.leido_at' : 'NULL AS leido_at';
    const selGrupo  = sch.grpCol ? `d.${sch.grpCol}` : 'NULL AS grupo_id';

    const sql = `
      SELECT m.id,
             ${selTitulo} AS titulo,
             m.cuerpo,
             ${selUrl} AS url,
             ${selUrls} AS urls,
             ${createdExpr} AS created_at,
             ${selAutor} AS autor,
             ${selLeido},
             ${selGrupo}
        FROM mensajes m
        JOIN ${sch.dest} d ON d.${sch.msgCol} = m.id AND d.${sch.alumCol} = $1
        ${leftJoinU}
       ORDER BY ${createdExpr} DESC NULLS LAST, m.id DESC
       LIMIT 200;
    `;
    const { rows } = await client.query(sql, [alumnoId]);
    res.json(rows);
  } catch (e) {
    console.error('[mensajes alumno] list:', e);
    res.status(500).json([]);
  } finally {
    client.release();
  }
});

// POST /firmas/api/alumno/:alumnoId/mensajes/:id/leer → marca como leído (si existe leido_at)
router.post('/api/alumno/:alumnoId/mensajes/:id/leer', mustMatchAlumnoParam, express.json(), async (req,res)=>{
  const alumnoId = Number(req.alumno_id);
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success:false });

  const client = await db.connect();
  try {
    const sch = await detectMsgSchema(client);
    if (!sch || !sch.dest || !sch.msgCol || !sch.alumCol) return res.json({ success:true });

    // Asegura la columna leido_at en tu tabla real (mensaje_destino)
    await ensureReadColumn(client, sch.dest);

    await client.query(
      `UPDATE ${sch.dest} SET leido_at = NOW()
        WHERE ${sch.msgCol}=$1 AND ${sch.alumCol}=$2`,
      [id, alumnoId]
    );
    res.json({ success:true });
  } catch (e) {
    console.error('[mensajes alumno] leer:', e);
    res.status(500).json({ success:false });
  } finally {
    client.release();
  }
});

// GET /firmas/api/alumno/:alumnoId/mensajes/unread_count
router.get('/api/alumno/:alumnoId/mensajes/unread_count', mustMatchAlumnoParam, async (req,res)=>{
  const alumnoId = Number(req.alumno_id);

  const client = await db.connect();
  try {
    const sch = await detectMsgSchema(client);
    if (!sch || !sch.dest || !sch.msgCol || !sch.alumCol) return res.json({ count: 0 });

    // Asegura que existe leido_at; si se acaba de crear, todos cuentan como no leídos
    await ensureReadColumn(client, sch.dest);

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM ${sch.dest} d
        WHERE d.${sch.alumCol} = $1
          AND d.leido_at IS NULL`,
      [alumnoId]
    );
    res.json({ count: rows[0]?.n ?? 0 });
  } catch (e) {
    console.error('[mensajes alumno] unread_count:', e);
    res.status(500).json({ count: 0 });
  } finally {
    client.release();
  }
});

module.exports = router;


