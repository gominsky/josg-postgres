// routes/control_firmas.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

/* ───────────────────── helpers ───────────────────── */

function toIsoLocal(dateStr, timeStr) {
  const d = (dateStr || '').toString().slice(0,10);   // YYYY-MM-DD
  const t = (timeStr || '00:00').toString().slice(0,5);// HH:mm
  return `${d}T${t}:00`;
}

async function getUsuarioById(id) {
  const rs = await db.query(
    `SELECT id, nombre, email, rol, password_hash
       FROM usuarios
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
  return rs.rows[0] || null;
}

async function getUsuarioByEmail(email) {
  const rs = await db.query(
    `SELECT id, nombre, email, rol, password_hash
       FROM usuarios
      WHERE lower(email) = lower($1)
      LIMIT 1`,
    [email]
  );
  return rs.rows[0] || null;
}

async function getProfesorIdByEmail(email) {
  const rs = await db.query(
    `SELECT id FROM profesores WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  return rs.rowCount ? rs.rows[0].id : null;
}

async function getGrupoIdsDeProfesor(profesorId) {
  const rs = await db.query(
    `SELECT grupo_id FROM profesor_grupo WHERE profesor_id = $1`,
    [profesorId]
  );
  return rs.rows.map(r => r.grupo_id);
}

/* ───────────────────── auth ───────────────────── */

/**
 * POST /api/login
 * - Autentica SIEMPRE contra tabla usuarios.
 * - Devuelve {success, usuario:{id,nombre,email,rol}} si ok.
 */
router.post('/api/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.json({ success: false, error: 'Faltan credenciales' });
  }

  try {
    const user = await getUsuarioByEmail(email);
    if (!user || !user.password_hash) {
      return res.json({ success: false, error: 'Credenciales inválidas' });
    }
    const ok = await bcrypt.compare(String(password), String(user.password_hash));
    if (!ok) return res.json({ success: false, error: 'Credenciales inválidas' });

    return res.json({
      success: true,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Error interno' });
  }
});

/* ───────────────────── salud/diag ───────────────────── */

router.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

router.get('/api/_diag', async (_req, res) => {
  try {
    const u = await db.query('SELECT COUNT(*)::int n FROM usuarios');
    const p = await db.query('SELECT COUNT(*)::int n FROM profesores');
    const e = await db.query('SELECT COUNT(*)::int n FROM eventos');
    res.json({ ok: true, usuarios: u.rows[0].n, profesores: p.rows[0].n, eventos: e.rows[0].n, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ───────────────────── eventos ───────────────────── */

/**
 * GET /api/eventos?usuario_id=#
 * - usuario.rol === 'admin'  → ve TODOS los eventos
 * - usuario.rol === 'docente'→ se localiza profesor por email y se filtra por sus grupos
 */
router.get('/api/eventos', async (req, res) => {
  const usuarioId = Number(req.query.usuario_id);
  if (!usuarioId) return res.status(400).json({ error: 'usuario_id requerido' });

  try {
    const usuario = await getUsuarioById(usuarioId);
    if (!usuario) return res.status(404).json({ error: 'usuario no encontrado' });

    let rs;
    if (usuario.rol === 'admin') {
      // Admin: todo
      rs = await db.query(`
        SELECT
          e.id, e.titulo,
          e.fecha_inicio, e.hora_inicio,
          e.fecha_fin,    e.hora_fin,
          g.nombre              AS grupo_nombre,
          COALESCE(s.nombre,'') AS espacio
        FROM eventos e
        JOIN grupos g        ON g.id = e.grupo_id
        LEFT JOIN espacios s ON s.id = e.espacio_id
        ORDER BY e.fecha_inicio ASC, e.hora_inicio NULLS FIRST, e.id ASC
      `);
    } else if (usuario.rol === 'docente') {
      // Docente: buscar profesor por email y filtrar por sus grupos
      const profesorId = await getProfesorIdByEmail(usuario.email);
      if (!profesorId) {
        console.warn(`[eventos] docente usuario_id=${usuarioId} (email=${usuario.email}) sin profesor asociado por email`);
        return res.json([]);
      }
      const grupoIds = await getGrupoIdsDeProfesor(profesorId);
      if (!grupoIds.length) return res.json([]);

      rs = await db.query(
        {
          text: `
            SELECT
              e.id, e.titulo,
              e.fecha_inicio, e.hora_inicio,
              e.fecha_fin,    e.hora_fin,
              g.nombre              AS grupo_nombre,
              COALESCE(s.nombre,'') AS espacio
            FROM eventos e
            JOIN grupos g        ON g.id = e.grupo_id
            LEFT JOIN espacios s ON s.id = e.espacio_id
            WHERE e.grupo_id = ANY($1)
            ORDER BY e.fecha_inicio ASC, e.hora_inicio NULLS FIRST, e.id ASC
          `,
          values: [grupoIds],
        }
      );
    } else {
      // Otros roles: por ahora no ven nada
      return res.json([]);
    }

    const eventos = (rs.rows || []).map(e => ({
      id: e.id,
      title: `${e.titulo} (${e.grupo_nombre})`,
      start: toIsoLocal(e.fecha_inicio, e.hora_inicio),
      end:   toIsoLocal(e.fecha_fin,    e.hora_fin),
      grupo_nombre: e.grupo_nombre,
      espacio: e.espacio || ''
    }));

    return res.json(eventos);
  } catch (err) {
    console.error('GET /api/eventos error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ───────────────────────────── detalle evento ───────────────────
router.get('/api/eventos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    const q = `
      SELECT
        e.id, e.titulo, e.descripcion,
        e.fecha_inicio, e.hora_inicio,
        e.fecha_fin,    e.hora_fin,
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
    if (!rs.rowCount) return res.status(404).json({ error: 'evento no encontrado' });

    const e = rs.rows[0];
    res.json({
      id: e.id,
      titulo: e.titulo,
      descripcion: e.descripcion || '',
      start: toIsoLocal(e.fecha_inicio, e.hora_inicio),
      end:   toIsoLocal(e.fecha_fin,    e.hora_fin),
      grupo_id: e.grupo_id,
      grupo_nombre: e.grupo_nombre,
      espacio: e.espacio || '',
    });
  } catch (err) {
    console.error('GET /api/eventos/:id error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────────── alumnos del evento ─────────────────
router.get('/api/eventos/:id/alumnos', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    // alumnos del grupo del evento + estado de asistencia si existe
    const q = `
      SELECT a.id, a.nombre, a.apellidos,
             CASE WHEN asi.id IS NOT NULL THEN true ELSE false END AS asistio,
             COALESCE(asi.observaciones,'') AS observaciones
      FROM eventos e
      JOIN alumno_grupo ag ON ag.grupo_id = e.grupo_id
      JOIN alumnos a       ON a.id = ag.alumno_id
      LEFT JOIN asistencias asi ON asi.evento_id = e.id AND asi.alumno_id = a.id
      WHERE e.id = $1 AND a.activo = true
      ORDER BY a.apellidos, a.nombre
    `;
    const rs = await db.query(q, [id]);
    res.json(rs.rows || []);
  } catch (err) {
    console.error('GET /api/eventos/:id/alumnos error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ────────────────────────── asistencias (historial) ────────────
router.get('/api/eventos/:id/asistencias', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    const q = `
      SELECT a.nombre, a.apellidos, asi.fecha, asi.hora, asi.tipo, asi.ubicacion
      FROM asistencias asi
      JOIN alumnos a ON a.id = asi.alumno_id
      WHERE asi.evento_id = $1
      ORDER BY asi.fecha DESC, asi.hora DESC
    `;
    const rs = await db.query(q, [id]);
    res.json(rs.rows || []);
  } catch (err) {
    console.error('GET /api/eventos/:id/asistencias error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────── firmar/guardar asistencias ────────────
// Body: { registros: [ { evento_id, alumno_id, asistio, observaciones } ] }
router.post('/api/firmar-alumnos', express.json(), async (req, res) => {
  const registros = Array.isArray(req.body?.registros) ? req.body.registros : [];
  if (!registros.length) return res.status(400).json({ error: 'registros requeridos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const r of registros) {
      const eid = Number(r.evento_id);
      const aid = Number(r.alumno_id);
      const estado = r.asistio ? 'presente' : 'ausente';
      const obs = (r.observaciones || '').toString().slice(0, 500);
      if (!eid || !aid) continue;

      await client.query(
        `INSERT INTO asistencias (evento_id, alumno_id, estado, observaciones)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (evento_id, alumno_id)
         DO UPDATE SET estado = EXCLUDED.estado,
                       observaciones = EXCLUDED.observaciones`,
        [eid, aid, estado, obs]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/firmar-alumnos error:', err);
    res.status(500).json({ success: false, error: 'Error guardando firmas' });
  } finally {
    client.release();
  }
});

// ─────────────────── observaciones generales del evento ─────────
router.patch('/api/eventos/:id/observaciones-generales', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const observaciones = (req.body?.observaciones || '').toString();
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    await db.query(`UPDATE eventos SET observaciones = $1 WHERE id = $2`, [observaciones, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/eventos/:id/observaciones-generales error:', err);
    res.status(500).json({ success: false, error: 'No se pudo actualizar observaciones' });
  }
});

// ─────────────────────────── activar/desactivar QR ──────────────
router.patch('/api/eventos/:id/activar', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const activo = !!req.body?.activo;
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    await db.query(`UPDATE eventos SET activo = $1 WHERE id = $2`, [activo, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/eventos/:id/activar error:', err);
    res.status(500).json({ success: false, error: 'No se pudo cambiar el estado' });
  }
});

// ───────────────────────────── grupos (para mensajes) ───────────
router.get('/api/grupos', async (_req, res) => {
  try {
    const rs = await db.query(`SELECT nombre FROM grupos ORDER BY nombre ASC`);
    res.json(rs.rows.map(r => r.nombre));
  } catch (err) {
    console.error('GET /api/grupos error:', err);
    res.status(500).json({ error: 'Error al obtener grupos' });
  }
});

module.exports = router;
