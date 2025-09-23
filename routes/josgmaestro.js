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
// El front llama a /control_firmas/login (no /api/login)  ← ver index.html
router.post('/login', express.json(), async (req, res) => {
  const email    = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ success:false, error:'Faltan credenciales' });

  try {
    const u = await getUsuarioByEmail(email);
    if (!u || !u.password_hash) return res.status(401).json({ success:false, error:'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ success:false, error:'Credenciales incorrectas' });

    if (req.session) { // cookie de sesión para vistas protegidas
      req.session.usuario_id  = u.id;
      req.session.usuario_rol = u.rol;
    }

    return res.json({ success:true, usuario:{ id:u.id, nombre:u.nombre || '', rol:u.rol || '' } });
  } catch (err) {
    console.error('POST /login error:', err);
    return res.status(500).json({ success:false, error:'Error interno' });
  }
});

/* ============ Eventos ============ */
// Lista para portal y calendario. Filtra por permisos si es docente.
router.get('/api/eventos', async (req, res) => {
  try{
    const usuarioId = Number(req.session?.usuario_id || req.query?.usuario_id);
    if (!usuarioId) return res.status(401).json({ error:'auth_required' });

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
        e.titulo,
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
  const usuarioId = Number(req.query.usuario_id);
  if (!usuarioId) return res.status(400).json({ error:'usuario_id requerido' });

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

router.post('/api/mensajes', express.json(), async (req, res) => {
  const { usuario_id, titulo, cuerpo, url, broadcast, grupos_nombres=[], grupos_ids=[], alumnos_ids=[] } = req.body || {};
  const usuarioId = Number(req.session?.usuario_id || usuario_id);
  if (!usuarioId) return res.status(400).json({ success:false, error:'usuario_id requerido' });
  if (!cuerpo || !String(cuerpo).trim()) return res.status(400).json({ success:false, error:'Mensaje vacío' });

  try{
    // permisos básicos
    const u = await db.query(`SELECT id, email, rol, nombre FROM usuarios WHERE id=$1 LIMIT 1`, [usuarioId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ success:false, error:'usuario no encontrado' });

    // destinatarios
    let grupoIds = [];
    let alumnoIds = [];
    let isBroadcast = false;

    if (user.rol === 'admin' && broadcast) {
      isBroadcast = true;
    } else if (user.rol === 'docente') {
      const profesorId = await getProfesorIdByEmail(user.email);
      const gs = profesorId ? await getGruposDeProfesor(profesorId) : [];
      const permitidos = new Set(gs.map(x=>x.id));
      // por nombre → ids
      if (Array.isArray(grupos_nombres) && grupos_nombres.length){
        const rs = await db.query(`SELECT id FROM grupos WHERE nombre = ANY($1::text[])`, [grupos_nombres]);
        for (const r of rs.rows){ if (permitidos.has(r.id)) grupoIds.push(r.id); }
      }
      // por ids directos
      if (Array.isArray(grupos_ids) && grupos_ids.length){
        for (const gId of grupos_ids.map(Number)) if (permitidos.has(gId)) grupoIds.push(gId);
      }
    }

    // Si se pasan alumnos directos (admin)
    if (user.rol === 'admin' && Array.isArray(alumnos_ids)) {
      alumnoIds = alumnos_ids.map(Number).filter(Number.isInteger);
    }

    if (!isBroadcast && grupoIds.length===0 && alumnoIds.length===0) {
      return res.status(400).json({ success:false, error:'Sin destinatarios válidos' });
    }

    const client = await db.connect();
    try{
      await client.query('BEGIN');

      const rsIns = await client.query(
        `INSERT INTO mensajes (usuario_id, titulo, cuerpo, url)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [usuarioId, titulo || null, cuerpo, url || null]
      );
      const mensajeId = rsIns.rows[0].id;

      if (isBroadcast) {
        await client.query(
          `INSERT INTO mensaje_destino (mensaje_id) VALUES ($1)`, [mensajeId]
        );
      } else {
        if (grupoIds.length) {
          await client.query(
            `INSERT INTO mensaje_destino (mensaje_id, grupo_id)
             SELECT $1, unnest($2::int[])`, [mensajeId, grupoIds]
          );
        }
        if (alumnoIds.length) {
          await client.query(
            `INSERT INTO mensaje_destino (mensaje_id, alumno_id)
             SELECT $1, unnest($2::int[])`, [mensajeId, alumnoIds]
          );
        }
      }

      // fan-out a suscripciones push (si existen)
      const dests = await client.query(`
        WITH dest_alumnos AS (
          SELECT md.alumno_id
            FROM mensaje_destino md
           WHERE md.mensaje_id = $1 AND md.alumno_id IS NOT NULL
          UNION
          SELECT ag.alumno_id
            FROM mensaje_destino md
            JOIN alumno_grupo ag ON ag.grupo_id = md.grupo_id
           WHERE md.mensaje_id = $1 AND md.grupo_id IS NOT NULL
          UNION
          SELECT a.id
            FROM mensaje_destino md
            JOIN alumnos a ON a.activo = true
           WHERE md.mensaje_id = $1 AND md.grupo_id IS NULL AND md.alumno_id IS NULL
        )
        SELECT DISTINCT alumno_id FROM dest_alumnos
      `, [mensajeId]);

      const alumnoIdsPush = dests.rows.map(r => r.alumno_id);
      if (alumnoIdsPush.length) {
        const subs = await client.query(
          `SELECT endpoint, p256dh, auth
             FROM push_suscripciones
            WHERE alumno_id = ANY($1::int[])`,
          [alumnoIdsPush]
        );

        const payload = { tipo:'mensaje', mensaje_id:mensajeId, titulo:titulo || '', cuerpo: cuerpo || '', url: url || null };
        for (const s of subs.rows) {
          try {
            const ret = await enviarPush({ endpoint:s.endpoint, keys:{ p256dh:s.p256dh, auth:s.auth } }, payload);
            if (ret === 'expired') await client.query('DELETE FROM push_suscripciones WHERE endpoint=$1', [s.endpoint]);
          } catch (e) { console.warn('Aviso: fallo enviando push a un endpoint:', e?.statusCode || e?.message); }
        }
      }

      await client.query('COMMIT');
      return res.json({ success:true, mensaje_id:mensajeId });
    }catch(e){
      await client.query('ROLLBACK');
      console.error('POST /api/mensajes TX error:', e);
      return res.status(500).json({ success:false, error:'internal_error_tx' });
    }finally{
      client.release();
    }
  }catch(err){
    console.error('POST /api/mensajes', err);
    return res.status(500).json({ success:false, error:'internal_error' });
  }
});

module.exports = router;
