// routes/josgmaestro.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router  = express.Router();
const db      = require('../database/db');
const bcrypt  = require('bcrypt');
const { enviarPush } = require('../utils/push');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambia-esto';
/* ============ Helpers mínimos ============ */
function toIsoLocal(dateStr, timeStr) {
  const d = (dateStr || '').toString().slice(0,10);   // YYYY-MM-DD
  const t = (timeStr || '00:00').toString().slice(0,5);// HH:MM
  return d ? `${d}T${t}:00` : null;
}

async function getUsuarioByEmail(email){
  const rs = await db.query(
    `SELECT id, nombre, email, rol, password_hash
       FROM usuarios
      WHERE lower(email)=lower($1)
      LIMIT 1`, [email]);
  return rs.rows[0] || null;
}

async function getProfesorIdByEmail(email){
  const rs = await db.query(
    `SELECT id FROM profesores WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  return rs.rowCount ? rs.rows[0].id : null;
}

async function getGruposDeProfesor(profesorId){
  const rs = await db.query(
    `SELECT g.id, g.nombre
       FROM profesor_grupo pg
       JOIN grupos g ON g.id = pg.grupo_id
      WHERE pg.profesor_id = $1
      ORDER BY g.nombre ASC`, [profesorId]);
  return rs.rows; // [{id,nombre}]
}
function authDual(req, res, next) {
  // 1) Si hay sesión (web), pasa
  if (req.session?.usuario_id) return next();

  // 2) Si viene Authorization: Bearer <token>, valida JWT
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'auth_required' });

  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = { id: payload.sub, rol: payload.rol }; // por si lo necesitas en handlers
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ✅ Aplica a todas las rutas de API
router.use('/api', authDual);

function getAuthUserId(req) {
  return req.session?.usuario_id || req.user?.id || null;
}

router.post('/logout', (req, res) => {
  if (req.session) {
    return req.session.destroy(() => res.json({ success: true }));
  }
  res.json({ success: true });
});

// === AUTH PÚBLICO (fuera del guard /api) =====================================
// POST /josgmaestro/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { rows } = await db.query(
      'SELECT id, nombre, rol, password_hash FROM usuarios WHERE email=$1',
      [email]
    );
    const u = rows[0];
    if (!u) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    // compara contraseña
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    // regenerar y guardar sesión
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ success:false, error:'session_regenerate_failed' });
    
      req.session.usuario_id  = u.id;
      req.session.usuario_rol = u.rol;
    
      req.session.save(err2 => {
        if (err2) return res.status(500).json({ success:false, error:'session_save_failed' });
        console.log('[LOGIN] set session', { sid: req.sessionID, uid: u.id });
        res.json({ success:true, usuario:{ id:u.id, nombre:u.nombre, rol:u.rol } });
        
      });
    });
    
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});
// POST /josgmaestro/token-login -> { token, usuario }
router.post('/token-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, rol, password_hash FROM usuarios WHERE email=$1',
      [email]
    );
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    // Token 2h con id (sub) y rol
    const token = jwt.sign({ sub: u.id, rol: u.rol }, JWT_SECRET, { expiresIn: '2h' });

    return res.json({
      token,
      usuario: { id: u.id, nombre: u.nombre, rol: u.rol }
    });
  } catch (err) {
    console.error('token-login error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
// === Subida de archivos (adjuntos) ===
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive:true }); }
const uploadStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const now = new Date();
    const dir = path.join(UPLOAD_ROOT, String(now.getFullYear()), String(now.getMonth()+1).padStart(2,'0'));
    ensureDir(dir);
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    const stamp = Date.now();
    cb(null, `${stamp}_${safe}`);
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10 MB, máx. 5
  fileFilter: (req, file, cb) => {
    const ok = /^(application\/pdf|image\/|audio\/)/.test(file.mimetype || '');
    cb(ok ? null : new Error('invalid_type'), ok);
  }
});
// Servir estáticos si el host no lo hace arriba (router montado bajo /josgmaestro => /josgmaestro/uploads)
router.use('/uploads', express.static(UPLOAD_ROOT));

router.post('/api/uploads', (req, res) => {
  const usuarioId = Number(getAuthUserId(req));
  if (!usuarioId) return res.status(401).json({ error: 'auth_required' });
  upload.array('files', 5)(req, res, function(err){
    if (err) {
      if (err.message === 'invalid_type') return res.status(400).json({ error:'invalid_type' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error:'file_too_big' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error:'too_many_files' });
      return res.status(400).json({ error: String(err.message || err) });
    }
    const files = (req.files || []).map(f => {
      // URL pública relativa al router montado (p. ej., /josgmaestro/uploads/aaaa/mm/archivo.ext)
      const rel = f.path.substring(UPLOAD_ROOT.length).replace(/\\/g,'/');
      const url = `/uploads${rel}`;
      return { filename: f.filename, originalname: f.originalname, size: f.size, mimetype: f.mimetype, url };
    });
    res.json({ files });
  });
});
/* ============ Eventos ============ */
// Lista para portal y calendario. Filtra por permisos si es docente.
router.get('/api/eventos', async (req, res) => {
  try {
    const usuarioId = Number(getAuthUserId(req));
    if (!usuarioId) return res.status(401).json({ error: 'auth_required' });

    const u = await db.query(
      `SELECT id, email, rol FROM usuarios WHERE id=$1 LIMIT 1`,
      [usuarioId]
    );
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error: 'usuario_not_found' });

    // si docente → sus grupos; si admin → todos
    let where = [];
    let args  = [];

    if (user.rol === 'docente') {
      const profesorId = await getProfesorIdByEmail(user.email);
      if (!profesorId) return res.json([]);
      const grupos = await getGruposDeProfesor(profesorId);
      const grupoIds = grupos.map(g => g.id);
      if (!grupoIds.length) return res.json([]);
      where.push(`e.grupo_id = ANY($${args.length+1})`);
      args.push(grupoIds);
    }

    // Helpers seguros: regex SIEMPRE sobre TEXT; cast a DATE/TIME solo si válido
    const FECHA_INI_TXT = `trim(e.fecha_inicio::text)`;
    const FECHA_FIN_TXT = `trim(e.fecha_fin::text)`;
    const HORA_INI_TXT  = `trim(e.hora_inicio::text)`;
    const HORA_FIN_TXT  = `trim(e.hora_fin::text)`;

    const EVENT_START = `CASE WHEN ${FECHA_INI_TXT} ~ '^\\d{4}-\\d{2}-\\d{2}$'
                             THEN (e.fecha_inicio)::date END`;

    const EVENT_END   = `CASE WHEN ${FECHA_FIN_TXT} ~ '^\\d{4}-\\d{2}-\\d{2}$'
                             THEN (e.fecha_fin)::date
                             ELSE ${EVENT_START} END`;

    const HORA_INI = `CASE WHEN ${HORA_INI_TXT} ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
                           THEN (split_part(${HORA_INI_TXT}, ' ', 1))::time END`;

    const HORA_FIN = `CASE WHEN ${HORA_FIN_TXT} ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
                           THEN (split_part(${HORA_FIN_TXT}, ' ', 1))::time END`;

    // Rango opcional (?start=YYYY-MM-DD&end=YYYY-MM-DD)
    const { start, end } = req.query || {};
    if (start && end) {
      args.push(start, end);
      // solapamiento: eventEnd >= viewStart AND eventStart < viewEnd
      where.push(`(${EVENT_END} >= $${args.length-1}::date AND ${EVENT_START} < $${args.length}::date)`);
      // y sólo eventos con fecha válida
      where.push(`${EVENT_START} IS NOT NULL`);
    }

    else {
      // Por defecto (portal): solo próximos eventos desde hoy y con fecha válida
      where.push(`(${EVENT_END} >= CURRENT_DATE)`);
      where.push(`${EVENT_START} IS NOT NULL`);
    }
    // Límite: calendario (con rango) hasta 1000; portal (sin rango) hasta ?limit o 5 por defecto
    const limitRows = (start && end) ? 1000 : 5;

    const sql = `
      SELECT
        e.id,
        e.titulo AS title,
        e.descripcion,
        e.fecha_inicio, e.hora_inicio,
        e.fecha_fin,    e.hora_fin,
        e.grupo_id,
        g.nombre              AS grupo_nombre,
        COALESCE(s.nombre,'') AS espacio,

        -- start ISO (YYYY-MM-DDTHH:MM:SS)
        CASE
          WHEN ${FECHA_INI_TXT} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
            to_char((e.fecha_inicio)::date, 'YYYY-MM-DD') || 'T' ||
            COALESCE(
              CASE WHEN ${HORA_INI_TXT} ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
                   THEN to_char(${HORA_INI}, 'HH24:MI')
                   ELSE '00:00'
              END,
              '00:00'
            ) || ':00'
          ELSE NULL
        END AS start,

        -- end ISO
        CASE
          WHEN ${FECHA_FIN_TXT} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
            to_char((e.fecha_fin)::date, 'YYYY-MM-DD') || 'T' ||
            COALESCE(
              CASE WHEN ${HORA_FIN_TXT} ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
                   THEN to_char(${HORA_FIN}, 'HH24:MI')
                   ELSE '00:00'
              END,
              '00:00'
            ) || ':00'
          ELSE NULL
        END AS "end"

      FROM eventos e
      JOIN grupos g        ON g.id = e.grupo_id
      LEFT JOIN espacios s ON s.id = e.espacio_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}

      ORDER BY
        ${EVENT_START} NULLS LAST,
        ${HORA_INI}   NULLS LAST,
        e.id ASC
      LIMIT ${limitRows}
    `;

    const rs = await db.query(sql, args);
    return res.json(rs.rows || []);
  } catch (err) {
    console.error('GET /api/eventos error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Detalle de un evento: devolvemos también las columnas crudas que usa el front
router.get('/api/eventos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error:'id inválido' });

  try{
    const q = `
      SELECT
        e.id, e.titulo, e.descripcion,
        e.fecha_inicio, e.hora_inicio,
        e.fecha_fin,    e.hora_fin,
        e.observaciones, e.token, e.activo,
        e.grupo_id,
        e.grace_minutes,
        g.nombre              AS grupo_nombre,
        COALESCE(s.nombre,'') AS espacio,
      COALESCE(e.grace_minutes, 15) AS grace_minutes
      FROM eventos e
      JOIN grupos g        ON g.id = e.grupo_id
      LEFT JOIN espacios s ON s.id = e.espacio_id
      WHERE e.id = $1
      LIMIT 1
    `;
    const rs = await db.query(q, [id]);
    if (!rs.rowCount) return res.status(404).json({ error:'evento no encontrado' });

    const e = rs.rows[0];
    res.json({
      id: e.id,
      titulo: e.titulo,
      descripcion: e.descripcion || '',
      fecha_inicio: e.fecha_inicio,
      hora_inicio: e.hora_inicio,
      fecha_fin: e.fecha_fin,
      hora_fin: e.hora_fin,
      observaciones: e.observaciones || '',
      token: e.token || '',
      activo: !!e.activo,
      grupo_id: e.grupo_id,
      grupo_nombre: e.grupo_nombre,
      espacio: e.espacio || '',
      start: toIsoLocal(e.fecha_inicio, e.hora_inicio),
      end:   toIsoLocal(e.fecha_fin,    e.hora_fin),
      grace_minutes: e.grace_minutes ?? 15
    });
  }catch(err){
    console.error('GET /api/eventos/:id error:', err);
    res.status(500).json({ error:'internal_error' });
  }
});

/* ============ Alumnos & Asistencias ============ */
router.get('/api/eventos/:id/alumnos', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error:'id inválido' });

  try{
    const q = `
     SELECT a.id, a.nombre, a.apellidos,
       CASE WHEN asi.id IS NOT NULL THEN true ELSE false END AS asistio,
       COALESCE(asi.observaciones,'') AS observaciones,
       asi.minutos_perdidos
      FROM evento_asignaciones ea
      JOIN alumnos a
        ON a.id = ea.alumno_id
      LEFT JOIN asistencias asi
        ON asi.evento_id = ea.evento_id
       AND asi.alumno_id = ea.alumno_id
      WHERE ea.evento_id = $1
      ORDER BY a.apellidos ASC, a.nombre ASC
    `;
    const rs = await db.query(q, [id]);
    res.json((rs.rows || []).map(r => ({
      id: r.id,
      nombre: r.nombre,
      apellidos: r.apellidos,
      asistio: r.asistio,
      observaciones: r.observaciones,
      minutos_perdidos: r.minutos_perdidos ?? null
    })));    
  }catch(err){
    console.error('GET /api/eventos/:id/alumnos error:', err);
    res.status(500).json({ error:'internal_error' });
  }
});

router.get('/api/eventos/:id/asistencias', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error:'id inválido' });

  try{
    const q = `
      SELECT
      a.nombre, a.apellidos,
      asi.fecha, asi.hora, asi.tipo, asi.ubicacion,
      COALESCE(asi.observaciones,'') AS observaciones,
      asi.minutos_perdidos
      FROM asistencias asi
      JOIN evento_asignaciones ea
        ON ea.evento_id = asi.evento_id
       AND ea.alumno_id = asi.alumno_id
      JOIN alumnos a
        ON a.id = asi.alumno_id
      WHERE asi.evento_id = $1
        AND (asi.tipo IS DISTINCT FROM 'ausente')
      ORDER BY asi.fecha DESC NULLS LAST, asi.hora DESC NULLS LAST, a.apellidos, a.nombre
    `;
    const rs = await db.query(q, [id]);
    const data = (rs.rows || []).map(r => ({
      nombre: r.nombre,
      apellidos: r.apellidos,
      fecha: r.fecha ? String(r.fecha).slice(0,10) : '',
      hora:  r.hora  ? String(r.hora).slice(0,5)   : '',
      tipo:  r.tipo || '',
      ubicacion: r.ubicacion || '',
      observaciones: r.observaciones || '',
      minutos_perdidos: (r.minutos_perdidos ?? null)
    }));    
    res.json(data);
  }catch(err){
    console.error('GET /api/eventos/:id/asistencias error:', err);
    res.status(500).json({ error:'internal_error' });
  }
});

// Asegúrate arriba del archivo:
// const pool = require('../database/db');

router.post('/api/firmar-alumnos', express.json(), async (req, res) => {
  const registros = Array.isArray(req.body?.registros) ? req.body.registros : [];
  if (!registros.length) return res.status(400).json({ success:false, ok:false, error:'registros requeridos' });

  const DEFAULT_GRACE = parseInt(process.env.QR_GRACE_MINUTES || '15', 10);

  let client; // importante: declarar fuera para usar en catch/finally
  try {
    client = await db.connect();          // ← aquí antes ponía pool.connect()
    await client.query('BEGIN');

    // --- precarga minutos de cortesía por evento ---
    const eventoIds = [...new Set(registros
      .map(r => Number(r.evento_id))
      .filter(Number.isFinite))];

    let graceByEvento = new Map();
    if (eventoIds.length) {
      const { rows } = await client.query(
        'SELECT id, grace_minutes FROM public.eventos WHERE id = ANY($1::int[])',
        [eventoIds]
      );
      graceByEvento = new Map(
        rows.map(r => [
          Number(r.id),
          (r.grace_minutes == null ? DEFAULT_GRACE : Number(r.grace_minutes))
        ])
      );
    }

    // --- detectar columnas opcionales en asistencias ---
    const cols = await client.query(`
      SELECT lower(column_name) AS c
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name = 'asistencias'
    `);
    const C = new Set(cols.rows.map(r=>r.c));
    const hasUpdatedAt = C.has('updated_at');
    const hasMinutos   = C.has('minutos_perdidos');

    let inserted=0, updated=0, deleted=0, skipped=0, notAssigned=0;

    for (const r of registros) {
      const eventoId = Number(r.evento_id);
      const alumnoId = Number(r.alumno_id);
      const asistio  = !!r.asistio;
      const obs      = (r.observaciones || '').toString().slice(0,500);

      if (!eventoId || !alumnoId) { skipped++; continue; }

      // cortesía (precargado; si no hay fila, cae al default)
      const GRACE = graceByEvento.get(eventoId) ?? DEFAULT_GRACE;

      // comprobar que está asignado al evento
      const ea = await client.query(
        `SELECT 1 FROM evento_asignaciones WHERE evento_id=$1 AND alumno_id=$2`,
        [eventoId, alumnoId]
      );
      if (!ea.rowCount) { notAssigned++; continue; }

      if (asistio) {
        // SQL tal cual; GRACE va como $4
        const sql = `
  WITH base AS (
    SELECT
      e.fecha_inicio::date AS fecha,
      CASE
        WHEN trim(a.hora_inicio::text) ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
          THEN split_part(trim(a.hora_inicio::text), ' ', 1)::time
        ELSE NULL
      END AS hora_asign,
      CASE
        WHEN trim(e.hora_inicio::text) ~ '^\\d{2}:\\d{2}(:\\d{2})?$'
          THEN split_part(trim(e.hora_inicio::text), ' ', 1)::time
        ELSE NULL
      END AS hora_evento
    FROM eventos e
    LEFT JOIN evento_asignaciones a
           ON a.evento_id = e.id AND a.alumno_id = $2
    WHERE e.id = $1
    LIMIT 1
  ),
  ref AS (
    SELECT
      (now() at time zone 'Europe/Madrid')::date      AS hoy,
      (now() at time zone 'Europe/Madrid')::time      AS ahora,
      (fecha::timestamp + COALESCE(hora_asign, hora_evento)) AS start_local
    FROM base
  ),
  calc AS (
    SELECT
      CASE
        WHEN start_local IS NULL THEN NULL
        ELSE GREATEST(
               CEIL(EXTRACT(EPOCH FROM (
                 (now() at time zone 'Europe/Madrid')::timestamp - start_local
               )) / 60.0)::int - $4::int,
               0
             )
      END AS minutos
    FROM ref
  )
  INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, observaciones, tipo${hasMinutos?', minutos_perdidos':''})
  VALUES (
    $1, $2,
    (now() at time zone 'Europe/Madrid')::date,
    (now() at time zone 'Europe/Madrid')::time,
    $3, 'manual'${hasMinutos?', (SELECT minutos FROM calc)':''}
  )
  ON CONFLICT (evento_id, alumno_id)
  DO UPDATE SET
    fecha = EXCLUDED.fecha,
    hora  = EXCLUDED.hora,
    observaciones = EXCLUDED.observaciones,
    tipo  = 'manual'
    ${hasMinutos ? ', minutos_perdidos = COALESCE(EXCLUDED.minutos_perdidos, asistencias.minutos_perdidos)' : ''}
    ${hasUpdatedAt ? ', updated_at = NOW()' : ''}
`;
        await client.query(sql, [eventoId, alumnoId, obs, GRACE]);

        const chk = await client.query(
          `SELECT 1 FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]
        );
        if (chk.rowCount) updated++; else inserted++;

      } else {
        const del = await client.query(
          `DELETE FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]
        );
        await client.query(
          `UPDATE evento_asignaciones
             SET ausencia_tipo_id = NULL
           WHERE evento_id = $1
             AND alumno_id = $2`,
          [eventoId, alumnoId]
        );
        deleted += del.rowCount;
      }
    }

    await client.query('COMMIT');
    return res.json({ success:true, ok:true, inserted, updated, deleted, skipped, notAssigned });

  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch(_) {} }
    console.error('POST /api/firmar-alumnos error:', err);
    return res.status(500).json({ success:false, ok:false, error:'internal_error' });
  } finally {
    if (client) client.release();
  }
});

router.patch('/api/eventos/:id/observaciones-generales', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const observaciones = (req.body?.observaciones || '').toString();
  if (!id) return res.status(400).json({ error:'id inválido' });

  try{
    await db.query(`UPDATE eventos SET observaciones=$1 WHERE id=$2`, [observaciones, id]);
    res.json({ success:true });
  }catch(err){
    console.error('PATCH /api/eventos/:id/observaciones-generales error:', err);
    res.status(500).json({ success:false, error:'No se pudo actualizar observaciones' });
  }
});

router.patch('/api/eventos/:id/activar', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const activo = !!req.body?.activo;
  if (!id) return res.status(400).json({ error:'id inválido' });

  try{
    await db.query(`UPDATE eventos SET activo=$1 WHERE id=$2`, [activo, id]);
    res.json({ success:true });
  }catch(err){
    console.error('PATCH /api/eventos/:id/activar error:', err);
    res.status(500).json({ success:false, error:'No se pudo cambiar el estado' });
  }
});

/* ============ Mensajes ============ */
router.get('/api/grupos', async (_req, res) => {
  try{
    const rs = await db.query(`SELECT nombre FROM grupos ORDER BY nombre ASC`);
    res.json(rs.rows.map(r=>r.nombre));
  }catch(err){
    console.error('GET /api/grupos error:', err);
    res.status(500).json({ error:'Error al obtener grupos' });
  }
});

router.get('/api/mis-grupos', async (req, res) => {
  const usuarioId = Number(getAuthUserId(req));
if (!usuarioId) return res.status(401).json({ error:'auth_required' });

  try{
    const u = await db.query(`SELECT id, email, rol FROM usuarios WHERE id=$1`, [usuarioId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error:'usuario no encontrado' });

    if (user.rol === 'admin') {
      const all = await db.query(`SELECT id, nombre FROM grupos ORDER BY nombre ASC`);
      return res.json(all.rows);
    }
    if (user.rol === 'docente') {
      const profesorId = await getProfesorIdByEmail(user.email);
      if (!profesorId) return res.json([]);
      const grupos = await getGruposDeProfesor(profesorId);
      return res.json(grupos);
    }
    return res.json([]);
  }catch(err){
    console.error('GET /api/mis-grupos', err);
    res.status(500).json({ error:'internal_error' });
  }
});

// Crear mensaje nuevo
router.post('/api/mensajes', express.json(), async (req, res) => {
  let {
    titulo,
    cuerpo,
    url = null,
    links = [],
    broadcast = false,
    grupos = [],
    instrumentos = [],
    usuario_id,       // compat móvil
    grupos_nombres = [],
    grupos_ids = [],
    alumnos_ids = []
  } = req.body || {};

  const usuarioId = Number(getAuthUserId(req));
if (!usuarioId) return res.status(401).json({ success:false, error:'auth_required' });

  titulo = (titulo || '').toString().trim();
  cuerpo = (cuerpo || '').toString().trim();
  if (!titulo || !cuerpo) return res.status(400).json({ success:false, error:'Título y cuerpo obligatorios' });

  // Normaliza URL y links
  const ensureProto = u => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u) ? u : ('https://' + u);
  url = url ? ensureProto(String(url).trim()) : null;
  if (!Array.isArray(links)) links = [];
  links = links.map(s => ensureProto(String(s).trim())).filter(Boolean).slice(0, 2);

  try {
    // Usuario/rol
    const u = await db.query(`SELECT id, email, rol, nombre FROM usuarios WHERE id=$1 LIMIT 1`, [usuarioId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ success:false, error:'usuario no encontrado' });

    // Normaliza arrays de grupos / instrumentos
    const groupIds = new Set(
      []
        .concat(Array.isArray(grupos) ? grupos : [])
        .concat(Array.isArray(grupos_ids) ? grupos_ids : [])
        .map(Number)
        .filter(Number.isInteger)
    );
    if (Array.isArray(grupos_nombres) && grupos_nombres.length) {
      const rs = await db.query(`SELECT id FROM grupos WHERE nombre = ANY($1::text[])`, [grupos_nombres]);
      rs.rows.forEach(r => groupIds.add(r.id));
    }
    const instIds = new Set(
      (Array.isArray(instrumentos) ? instrumentos : [])
        .map(Number)
        .filter(Number.isInteger)
    );

    // Restricciones para docentes
    if (user.rol === 'docente') {
      const profRs = await db.query(`SELECT id FROM profesores WHERE lower(email)=lower($1) LIMIT 1`, [user.email]);
      const profesorId = profRs.rowCount ? profRs.rows[0].id : null;
      const gs = profesorId
        ? await db.query(`SELECT grupo_id AS id FROM profesor_grupo WHERE profesor_id=$1`, [profesorId])
        : { rows: [] };
      const permitidos = new Set(gs.rows.map(x => x.id));

      for (const gid of Array.from(groupIds)) {
        if (!permitidos.has(gid)) groupIds.delete(gid);
      }
      if (broadcast) return res.status(403).json({ success:false, error:'No puedes enviar a todos' });
    }

   const rsIns = await db.query(
  `INSERT INTO mensajes (titulo, cuerpo, url, creado_por, urls)
   VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
  [titulo, cuerpo, url, usuarioId, Array.isArray(links) ? links : []]
);
    const mensajeId = rsIns.rows[0].id;

    // Fan-out
    const client = await db.connect();
    let enviados = 0;
    try {
      await client.query('BEGIN');

      const addEntrega = async (alumnoIds) => {
        if (!alumnoIds.length) return 0;
        const r = await client.query(
          `INSERT INTO mensaje_entrega (mensaje_id, alumno_id, entregado_at)
           SELECT $1, unnest($2::int[]), NOW()
           ON CONFLICT (mensaje_id, alumno_id) DO NOTHING
           RETURNING alumno_id`,
          [mensajeId, alumnoIds]
        );
        return r.rowCount;
      };

      if (broadcast && user.rol === 'admin') {
        await client.query(`INSERT INTO mensaje_destino (mensaje_id) VALUES ($1)`, [mensajeId]);
        const all = await client.query(`SELECT id FROM alumnos WHERE activo = true`);
        const ids = all.rows.map(r => r.id);
        enviados = await addEntrega(ids);

      } else {
        // grupo + instrumento
        if (groupIds.size && instIds.size) {
          const r = await client.query(`
            SELECT DISTINCT a.id
            FROM alumnos a
            JOIN alumno_grupo ag       ON ag.alumno_id = a.id
            JOIN alumno_instrumento ai ON ai.alumno_id = a.id
            WHERE ag.grupo_id = ANY($1::int[])
              AND ai.instrumento_id = ANY($2::int[])`,
            [Array.from(groupIds), Array.from(instIds)]
          );
          const ids = r.rows.map(x => x.id);
          if (ids.length) {
            await client.query(
              `INSERT INTO mensaje_destino (mensaje_id, alumno_id)
               SELECT $1, unnest($2::int[])
               ON CONFLICT DO NOTHING`,
              [mensajeId, ids]
            );
            enviados += await addEntrega(ids);
          }
        }

        // solo grupos
        if (groupIds.size && !instIds.size) {
          const gids = Array.from(groupIds);
          await client.query(
            `INSERT INTO mensaje_destino (mensaje_id, grupo_id)
             SELECT $1, unnest($2::int[])`,
            [mensajeId, gids]
          );
          const r = await client.query(
            `SELECT DISTINCT ag.alumno_id AS id
               FROM alumno_grupo ag
              WHERE ag.grupo_id = ANY($1::int[])`,
            [gids]
          );
          enviados += await addEntrega(r.rows.map(x => x.id));
        }

        // solo instrumentos
        if (instIds.size && !groupIds.size) {
          const r = await client.query(
            `SELECT DISTINCT ai.alumno_id AS id
               FROM alumno_instrumento ai
              WHERE ai.instrumento_id = ANY($1::int[])`,
            [Array.from(instIds)]
          );
          const ids = r.rows.map(x => x.id);
          if (ids.length) {
            await client.query(
              `INSERT INTO mensaje_destino (mensaje_id, alumno_id)
               SELECT $1, unnest($2::int[])
               ON CONFLICT DO NOTHING`,
              [mensajeId, ids]
            );
            enviados += await addEntrega(ids);
          }
        }

        // alumnos directos (admin)
        if (Array.isArray(alumnos_ids) && alumnos_ids.length && user.rol === 'admin') {
          const ids = alumnos_ids.map(Number).filter(Number.isInteger);
          if (ids.length) {
            await client.query(
              `INSERT INTO mensaje_destino (mensaje_id, alumno_id)
               SELECT $1, unnest($2::int[])
               ON CONFLICT DO NOTHING`,
              [mensajeId, ids]
            );
            enviados += await addEntrega(ids);
          }
        }

        // verificación
        const chk = await client.query(
          `SELECT 1 FROM mensaje_destino WHERE mensaje_id=$1 LIMIT 1`,
          [mensajeId]
        );
        if (!chk.rowCount) throw new Error('Sin destinatarios válidos');
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      try { await db.query(`DELETE FROM mensajes WHERE id=$1`, [mensajeId]); } catch {}
      throw e;
    } finally {
      client.release();
    }

    return res.json({ success:true, mensaje_id: mensajeId, enviados });
  } catch (err) {
    console.error('POST /api/mensajes error:', err);
    return res.status(500).json({ success:false, error: err.message || 'internal_error' });
  }
});
// PATCH /api/eventos/:id/grace  { grace_minutes: 0..120 }
router.patch('/api/eventos/:id/grace', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success:false, error:'id inválido' });

  let minutes = parseInt(req.body?.minutes, 10);
  if (!Number.isFinite(minutes) || minutes < 0) minutes = 0;
  if (minutes > 120) minutes = 120;

  try {
    await db.query(`UPDATE eventos SET grace_minutes=$1 WHERE id=$2`, [minutes, id]);
    res.json({ success:true, minutes });
  } catch (err) {
    console.error('PATCH /api/eventos/:id/grace error:', err);
    res.status(500).json({ success:false, error:'No se pudo actualizar minutos de cortesía' });
  }
});


module.exports = router;
