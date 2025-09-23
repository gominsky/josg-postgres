// routes/josgmaestro.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const bcrypt  = require('bcrypt');
const { enviarPush } = require('../utils/push');

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

/* ============ Auth (login maestro) ============ */
router.use('/api', (req, res, next) => {
  if (req.session?.usuario_id) return next();
  return res.status(401).json({ error: 'auth_required' });
});

router.post('/logout', (req, res) => {
  if (req.session) {
    return req.session.destroy(() => res.json({ success: true }));
  }
  res.json({ success: true });
});

// === AUTH PÚBLICO (fuera del guard /api) =====================================

// POST /josgmaestro/login
router.post('/login', express.json(), async (req, res) => {
  const email    = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
    console.log('[LOGIN] body:', req.body);
  console.log('[LOGIN] sets session for usuario_id?');
  if (!email || !password) {
    return res.status(400).json({ success:false, error: 'Faltan credenciales' });
  }

  try {
    // lee exactamente de la tabla `usuarios` (con password_hash bcrypt)
    const rs = await db.query(
      `SELECT id, nombre, apellidos, email, rol, password_hash
         FROM usuarios
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email]
    );
    const u = rs.rows[0];
    if (!u) {
      // mismo mensaje genérico: no revelamos si el email existe
      return res.status(401).json({ success:false, error:'Credenciales incorrectas' });
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      return res.status(401).json({ success:false, error:'Credenciales incorrectas' });
    }

    // crea sesión
    req.session.usuario_id  = u.id;
    req.session.usuario_rol = u.rol;

    // respuesta mínima para el front
    return res.json({
      success: true,
      usuario: {
        id: u.id,
        nombre: u.nombre || '',
        apellidos: u.apellidos || '',
        rol: u.rol
      }
    });
  } catch (err) {
    console.error('POST /josgmaestro/login error:', err);
    return res.status(500).json({ success:false, error:'Error interno' });
  }
});

// GET /josgmaestro/me  -> comprueba sesión (útil para depurar)
router.get('/me', (req, res) => {
  if (!req.session?.usuario_id) return res.status(401).json({ logged:false });
  res.json({
    logged: true,
    usuario: { id: req.session.usuario_id, rol: req.session.usuario_rol }
  });
});

/* ============ Eventos ============ */
// Lista para portal y calendario. Filtra por permisos si es docente.
router.get('/api/eventos', async (req, res) => {
   try {
    const usuarioId = Number(req.session?.usuario_id);
    if (!usuarioId) return res.status(401).json({ error: 'auth_required' });

    const u = await db.query(`SELECT id, email, rol FROM usuarios WHERE id=$1 LIMIT 1`, [usuarioId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error:'usuario_not_found' });

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

    // Rango opcional (FullCalendar suele pasar ?start=…&end=…)
    const { start, end } = req.query || {};
    if (start) { where.push(`e.fecha_inicio >= $${args.length+1}::date`); args.push(start); }
    if (end)   { where.push(`e.fecha_inicio <  $${args.length+1}::date`); args.push(end); }

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
        -- start/end ISO local a partir de fecha+hora
        CASE WHEN e.fecha_inicio IS NOT NULL
             THEN to_char(e.fecha_inicio,'YYYY-MM-DD') || 'T' ||
                  coalesce(to_char(e.hora_inicio,'HH24:MI'),'00:00') || ':00'
             ELSE NULL END AS start,
        CASE WHEN e.fecha_fin IS NOT NULL
             THEN to_char(e.fecha_fin,'YYYY-MM-DD') || 'T' ||
                  coalesce(to_char(e.hora_fin,'HH24:MI'),'00:00') || ':00'
             ELSE NULL END AS "end"
      FROM eventos e
      JOIN grupos g        ON g.id = e.grupo_id
      LEFT JOIN espacios s ON s.id = e.espacio_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.fecha_inicio NULLS LAST, e.hora_inicio NULLS LAST, e.id ASC
      LIMIT 1000
    `;

    const rs = await db.query(sql, args);
    return res.json(rs.rows || []);
  }catch(err){
    console.error('GET /api/eventos error:', err);
    return res.status(500).json({ error:'internal_error' });
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
        g.nombre              AS grupo_nombre,
        COALESCE(s.nombre,'') AS espacio
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
      end:   toIsoLocal(e.fecha_fin,    e.hora_fin)
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
             COALESCE(asi.observaciones,'') AS observaciones
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
    res.json(rs.rows || []);
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
        COALESCE(asi.observaciones,'') AS observaciones
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
      observaciones: r.observaciones || ''
    }));
    res.json(data);
  }catch(err){
    console.error('GET /api/eventos/:id/asistencias error:', err);
    res.status(500).json({ error:'internal_error' });
  }
});

router.post('/api/firmar-alumnos', express.json(), async (req, res) => {
  const registros = Array.isArray(req.body?.registros) ? req.body.registros : [];
  if (!registros.length) return res.status(400).json({ success:false, ok:false, error:'registros requeridos' });

  const client = await db.connect();
  try{
    await client.query('BEGIN');

    // Si existe updated_at en asistencias, lo actualizamos
    const cols = await client.query(`
      SELECT lower(column_name) AS c
      FROM information_schema.columns
      WHERE table_name = 'asistencias'`);
    const hasUpdatedAt = new Set(cols.rows.map(r=>r.c)).has('updated_at');

    let inserted=0, updated=0, deleted=0, skipped=0, notAssigned=0;

    for (const r of registros) {
      const eventoId = Number(r.evento_id);
      const alumnoId = Number(r.alumno_id);
      const asistio  = !!r.asistio;
      const obs      = (r.observaciones || '').toString().slice(0,500);
      if (!eventoId || !alumnoId) { skipped++; continue; }

      const ea = await client.query(
        `SELECT 1 FROM evento_asignaciones WHERE evento_id=$1 AND alumno_id=$2`,
        [eventoId, alumnoId]);
      if (!ea.rowCount) { notAssigned++; continue; }

      if (asistio) {
        const ex = await client.query(
          `SELECT id FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]);

        if (ex.rowCount) {
          const qUpd =
            `UPDATE asistencias
                SET fecha=CURRENT_DATE, hora=CURRENT_TIME,
                    observaciones=$3, tipo='manual'` +
            (hasUpdatedAt ? `, updated_at=NOW()` : ``) +
            ` WHERE evento_id=$1 AND alumno_id=$2`;
          await client.query(qUpd, [eventoId, alumnoId, obs]);
          updated++;
        } else {
          await client.query(
            `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, observaciones, tipo)
             VALUES ($1,$2,CURRENT_DATE,CURRENT_TIME,$3,'manual')`,
            [eventoId, alumnoId, obs]);
          inserted++;
        }
      } else {
        const del = await client.query(
          `DELETE FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]);
        deleted += del.rowCount;
      }
    }

    await client.query('COMMIT');
    res.json({ success:true, ok:true, inserted, updated, deleted, skipped, notAssigned });
  }catch(err){
    await client.query('ROLLBACK');
    console.error('POST /api/firmar-alumnos error:', err);
    res.status(500).json({ success:false, ok:false, error:'internal_error' });
  }finally{
    client.release();
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
  const usuarioId = Number(req.session?.usuario_id);
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

  const usuarioId = Number(req.session?.usuario_id);
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

module.exports = router;
