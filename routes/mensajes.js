// routes/mensajes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { enviarPush } = require('../utils/push');
const { isAuthenticatedApi: isAuthenticated, isDocenteApi: isDocente, requireAlumno } = require('../middleware/auth');
const path = require('path');
const fs   = require('fs');
const multer = require('multer');

/* ====== almacenamiento de adjuntos en /public/mensajes ====== */
const PUBLIC_MSG_DIR = path.join(__dirname, '..', 'public', 'mensajes');
if (!fs.existsSync(PUBLIC_MSG_DIR)) fs.mkdirSync(PUBLIC_MSG_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PUBLIC_MSG_DIR),
  filename: (req, file, cb) => {
    const safeBase = String(file.originalname || 'archivo')
      .replace(/[^\w.\-()+\s]/g, '')      // quita caracteres raros
      .replace(/\s+/g, '_')
      .slice(0, 80);
    const ext = path.extname(safeBase).toLowerCase();
    const base = path.basename(safeBase, ext);
    const unique = Date.now() + '_' + Math.random().toString(36).slice(2,8);
    cb(null, base + '__' + unique + ext);
  }
});

// (opcional) filtro de tipos y tamaño (10 MB)
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb){
    const okTypes = [
      'application/pdf',
      'image/png','image/jpeg','image/webp',
      'application/zip','application/x-zip-compressed',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (okTypes.includes(file.mimetype)) return cb(null, true);
    cb(null, true); // o pon false para bloquear; aquí lo dejamos permisivo
  }
});

/* --------------------------- utilidades --------------------------- */
async function borrarAdjuntosFisicos(client, mensajeId) {
  // lee los adjuntos ANTES de borrar filas
  const { rows } = await client.query(
    'SELECT filename FROM mensaje_adjuntos WHERE mensaje_id = $1',
    [mensajeId]
  );

  for (const r of rows) {
    const stored = String(r.filename || '');     // p.ej. "/mensajes/ARCHIVO__123abc.pdf"
    const fileOnDisk = path.join(
      PUBLIC_MSG_DIR,
      path.basename(stored)                       // => "ARCHIVO__123abc.pdf"
    );
    try {
      await fs.promises.unlink(fileOnDisk);
      // console.log('🗑️ borrado', fileOnDisk);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn('No se pudo borrar adjunto:', fileOnDisk, e.message);
      }
    }
  }
}

function toIntArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (typeof x === 'string') return x.split(',').map(n => parseInt(n, 10)).filter(Number.isInteger);
  return [];
}
function sanitizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  // añade https:// si el usuario pegó "ejemplo.com"
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  return s;
}
function toUrlArray(x, max = 10) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : [x];
  const out = [];
  for (const v of arr) {
    const u = sanitizeUrl(v);
    if (u) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

router.get('/ayuda', (req, res) => {
  res.render('ayuda_mensajes');
});

/* ---------------------------- crear/enviar ---------------------------- */
router.post('/', isAuthenticated, isDocente, upload.array('adjuntos', 5), async (req, res) => {
  // Campos vienen ahora vía multipart/form-data (pero tu toIntArray/toUrlArray siguen sirviendo)
  const titulo = (req.body.titulo || '').trim();
  const cuerpo = (req.body.cuerpo || '').trim();
  const url    = sanitizeUrl(req.body.url || null);
  const links  = toUrlArray(req.body.links, 10); // admite múltiples 'links' en el form

  const broadcast = String(req.body.broadcast) === 'true' || req.body.broadcast === true;
  const gruposArr = toIntArray(req.body.grupos);         // admite "1,2,3" o múltiples campos
  const instrArr  = toIntArray(req.body.instrumentos);

  // Resolver por nombre (igual que antes)
  const nombresUnicos = [];
  if (req.body?.grupo_nombre) nombresUnicos.push(String(req.body.grupo_nombre).trim());
  if (Array.isArray(req.body?.grupos_nombres)) {
    for (const n of req.body.grupos_nombres) {
      const s = String(n || '').trim();
      if (s) nombresUnicos.push(s);
    }
  }
  const gruposNombres = [...new Set(nombresUnicos)];

  if (!broadcast && gruposArr.length === 0 && gruposNombres.length > 0) {
    try {
      const rs = await db.query('SELECT id FROM grupos WHERE nombre = ANY($1::text[])', [gruposNombres]);
      const ids = rs.rows.map(r => Number(r.id)).filter(Number.isInteger);
      if (ids.length) gruposArr.push(...ids);
    } catch (e) { console.error('Error resolviendo grupos por nombre:', e.message); }
  }

  if (!titulo || !cuerpo) {
    return res.status(400).json({ error: 'Faltan título o mensaje.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) crear mensaje (añadimos urls JSON como ya hacías)
    const userId = req.session.usuario.id;
    const { rows } = await client.query(
      `INSERT INTO mensajes (titulo, cuerpo, url, urls, creado_por)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [titulo, cuerpo, url || null, JSON.stringify(links), userId]
    );
    const mensajeId = rows[0].id;

    // 1.b) guardar adjuntos si llegaron (guardar ruta pública /mensajes/...)
    if (Array.isArray(req.files) && req.files.length) {
      const vals = req.files.map((f, i) =>
        `($1, $${i*4+2}, $${i*4+3}, $${i*4+4}, $${i*4+5})`
      ).join(',');
      const params = [mensajeId];
      for (const f of req.files) {
        params.push(
          '/mensajes/' + f.filename,     // 👈 ahora bajo /public/mensajes
          f.originalname || null,
          f.mimetype || null,
          Number(f.size) || null
        );
      }
      await client.query(
        `INSERT INTO mensaje_adjuntos (mensaje_id, filename, original_name, mime, size_bytes)
         VALUES ${vals}`,
        params
      );
    }

    // 2) registrar destinos (igual que tenías)
    if (broadcast) {
      await client.query('INSERT INTO mensaje_destino (mensaje_id) VALUES ($1)', [mensajeId]);
    }
    if (gruposArr.length) {
      const vals = gruposArr.map((_, i) => `($1,$${i + 2})`).join(',');
      await client.query(
        `INSERT INTO mensaje_destino (mensaje_id, grupo_id) VALUES ${vals}`,
        [mensajeId, ...gruposArr]
      );
    }

    // helpers y resolución de destinatarios (sin cambios) …
    // Devuelve IDs de alumno por grupo(s)
async function getAlumnoIdsPorGrupo(client, grupos){
  // Usa la tabla de relación (ajusta el nombre si difiere)
  const { rows } = await client.query(
    `SELECT DISTINCT ag.alumno_id
       FROM alumno_grupo ag
      WHERE ag.grupo_id = ANY($1::int[])`,
    [grupos]
  );
  return rows.map(r => Number(r.alumno_id)).filter(Number.isInteger);
}

// Devuelve IDs de alumno por instrumento(s)
async function getAlumnoIdsPorInstrumentos(client, instrumentos){
  // 1) Intento con tabla relación alumno_instrumento
  try{
    const { rows } = await client.query(
      `SELECT DISTINCT ai.alumno_id
         FROM alumno_instrumento ai
        WHERE ai.instrumento_id = ANY($1::int[])`,
      [instrumentos]
    );
    if (rows.length) return rows.map(r => Number(r.alumno_id)).filter(Number.isInteger);
  }catch{}

  // 2) Fallback si guardas el instrumento en alumnos.instrumento_id
  const { rows } = await client.query(
    `SELECT DISTINCT a.id AS alumno_id
       FROM alumnos a
      WHERE a.instrumento_id = ANY($1::int[])`,
    [instrumentos]
  );
  return rows.map(r => Number(r.alumno_id)).filter(Number.isInteger);
}
    let destinatariosSet = new Set();
    const hasGroups = gruposArr.length > 0;
    const hasInstr  = instrArr.length > 0;

    if (broadcast) {
      const all = await client.query('SELECT id FROM alumnos');
      all.rows.forEach(r => destinatariosSet.add(r.id));
    } else if (hasGroups && hasInstr) {
      const porGrupo = new Set(await getAlumnoIdsPorGrupo(client, gruposArr));
      const porIns   = new Set(await getAlumnoIdsPorInstrumentos(client, instrArr));
      for (const id of porGrupo) if (porIns.has(id)) destinatariosSet.add(id);
    } else if (hasGroups) {
      const ids = await getAlumnoIdsPorGrupo(client, gruposArr);
      ids.forEach(id => destinatariosSet.add(id));
    } else if (hasInstr) {
      const ids = await getAlumnoIdsPorInstrumentos(client, instrArr);
      ids.forEach(id => destinatariosSet.add(id));
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selecciona alcance: Todos, Grupos, Instrumento(s) o Grupo+Instrumento.' });
    }

    const alumnoIds = Array.from(destinatariosSet).filter(Number.isInteger);

    if (alumnoIds.length) {
      const vals = alumnoIds.map((_, i) => `($1,$${i + 2})`).join(',');
      await client.query(
        `INSERT INTO mensaje_entrega (mensaje_id, alumno_id)
         VALUES ${vals}
         ON CONFLICT DO NOTHING`,
        [mensajeId, ...alumnoIds]
      );
    }

    // push (igual que antes)
    if (alumnoIds.length) {
      const subs = await client.query(
        `SELECT endpoint, p256dh, auth
         FROM push_suscripciones
         WHERE alumno_id = ANY($1::int[])`,
        [alumnoIds]
      );
      const notifTitle = `Notificación JOSG: ${titulo}`;
      const payload = { tipo:'mensaje', mensaje_id: mensajeId, titulo: notifTitle, cuerpo, url: url || null, urls: links };
      for (const s of subs.rows) {
        try {
          const ret = await enviarPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          if (ret === 'expired') await client.query('DELETE FROM push_suscripciones WHERE endpoint = $1', [s.endpoint]);
        } catch (e) { console.warn('Aviso: fallo enviando push:', e?.statusCode || e?.message); }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, mensaje_id: mensajeId, enviados: alumnoIds.length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Crear/enviar mensaje:', err);
    res.status(500).json({ error: 'Error creando o enviando el mensaje' });
  } finally {
    client.release();
  }
});

/* ---------------------- suscripción web push ---------------------- */
/** body: { endpoint, keys: { p256dh, auth } } */
router.post('/push/subscribe', requireAlumno, async (req, res) => {
  const alumno_id = req.alumno_id;
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  try {
    await db.query(`
      INSERT INTO push_suscripciones (alumno_id, endpoint, p256dh, auth)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (endpoint) DO UPDATE
        SET alumno_id = EXCLUDED.alumno_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `, [alumno_id, endpoint, keys.p256dh, keys.auth]);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Guardando suscripción', e);
    res.status(500).json({ error: 'No se pudo guardar la suscripción' });
  }
});

/* ------------------------- bandeja (app) -------------------------- */
/** GET /mensajes/app/mensajes?desde_id=0 */
router.get('/app/mensajes', requireAlumno, async (req, res) => {
  const alumnoId = req.alumno_id;
  if (!alumnoId) return res.status(400).json({ error: 'alumno_id requerido' });
  const desdeId = parseInt(req.query.desde_id, 10) || 0;

  try {
    const { rows } = await db.query(`
      SELECT
        m.id, m.titulo, m.cuerpo, m.url,
        -- Normaliza 'urls' a JSONB funcione siendo TEXT o JSON/JSONB
        COALESCE(NULLIF(m.urls::text, '')::jsonb, '[]'::jsonb) AS urls,
        m.created_at, me.leido_at,
        m.creado_por,
        COALESCE(NULLIF(TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellidos,'')), ''),
                 u.email,
                 'Sistema') AS autor,
        COALESCE(a.adjuntos, '[]'::json) AS adjuntos
      FROM mensaje_entrega me
      JOIN mensajes m ON m.id = me.mensaje_id
      LEFT JOIN usuarios u ON u.id = m.creado_por
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'filename', ma.filename,
          'original_name', ma.original_name,
          'mime', ma.mime,
          'size', ma.size_bytes
        ) ORDER BY ma.id ASC) AS adjuntos
        FROM mensaje_adjuntos ma
        WHERE ma.mensaje_id = m.id
      ) a ON true
      WHERE me.alumno_id = $1 AND m.id > $2
      ORDER BY m.id DESC
      LIMIT 50
    `, [alumnoId, desdeId]);

    res.json(rows);
  } catch (e) {
    console.error('❌ Listando mensajes', e);
    res.status(500).json({ error: 'No se pudo obtener mensajes' });
  }
});

/* ---------------------- marcar como leído (app) ------------------- */
/** POST /mensajes/app/mensajes/:id/leer */
router.post('/app/mensajes/:id/leer', requireAlumno, async (req, res) => {
  const alumnoId = req.alumno_id;
  const id = parseInt(req.params.id, 10);
  if (!alumnoId || !id) return res.status(400).json({ error: 'Datos inválidos' });

  try {
    await db.query(
      `UPDATE mensaje_entrega SET leido_at = NOW()
       WHERE mensaje_id = $1 AND alumno_id = $2`,
      [id, alumnoId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Marcando leído', e);
    res.status(500).json({ error: 'No se pudo actualizar' });
  }
});

/* ---------------------- últimos 5 (admin web) --------------------- */
router.get('/ultimos', isAuthenticated, isDocente, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50); // tamaño de página
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);    // página actual
  const offset = (page - 1) * limit;

  try {
    // Total de mensajes
    const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS total FROM mensajes');
    const total = countRows[0]?.total || 0;

    // Mensajes de la página solicitada
    const { rows: items } = await db.query(`
      SELECT
  m.id,
  m.titulo,
  m.cuerpo,
  m.url,
  COALESCE(NULLIF(m.urls::text, '')::jsonb, '[]'::jsonb) AS urls,
  m.created_at,
  m.creado_por,
  COALESCE(NULLIF(TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellidos,'')), ''), u.email, 'Sistema') AS autor,
  COALESCE(a.adjuntos, '[]'::json) AS adjuntos
      FROM mensajes m
      LEFT JOIN usuarios u ON u.id = m.creado_por
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'filename', ma.filename,
          'original_name', ma.original_name,
          'mime', ma.mime,
          'size', ma.size_bytes
        ) ORDER BY ma.id ASC) AS adjuntos
        FROM mensaje_adjuntos ma
        WHERE ma.mensaje_id = m.id
      ) a ON true
      ORDER BY m.id DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]); 

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      items,
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (e) {
    console.error('❌ Listando últimos mensajes', e);
    res.status(500).json({ success: false, error: 'No se pudo obtener la lista de mensajes' });
  }
});

/** DELETE /mensajes/:id */
router.delete('/:id', isAuthenticated, isDocente, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) borrar ficheros físicos de los adjuntos
    await borrarAdjuntosFisicos(client, id);

    // 2) limpiar tablas dependientes (si no tienes CASCADE en todas)
    await client.query('DELETE FROM mensaje_entrega WHERE mensaje_id = $1', [id]);
    await client.query('DELETE FROM mensaje_destino WHERE mensaje_id = $1', [id]);
    // Si NO tienes ON DELETE CASCADE en mensaje_adjuntos, descomenta:
    // await client.query('DELETE FROM mensaje_adjuntos WHERE mensaje_id = $1', [id]);

    // 3) borrar el mensaje
    const del = await client.query('DELETE FROM mensajes WHERE id = $1', [id]);

    await client.query('COMMIT');

    if (del.rowCount === 0) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }
    res.json({ success: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Eliminando mensaje', e);
    res.status(500).json({ error: 'No se pudo eliminar el mensaje' });
  } finally {
    client.release();
  }
});


module.exports = router;
