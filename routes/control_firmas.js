// routes/control_firmas.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const { enviarPush } = require('../utils/push'); 

/* ───────────────────── helpers ───────────────────── */
async function getProfesorIdByEmail(email) {
  if (!email) return null;
  const rs = await db.query(`SELECT id FROM profesores WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  return rs.rowCount ? rs.rows[0].id : null;
}

async function getGruposDeProfesor(profesorId) {
  const rs = await db.query(
    `SELECT g.id, g.nombre
       FROM profesor_grupo pg
       JOIN grupos g ON g.id = pg.grupo_id
      WHERE pg.profesor_id = $1
      ORDER BY g.nombre ASC`,
    [profesorId]
  );
  return rs.rows; // [{id,nombre}]
}


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
// ====== LOGIN PORTAL MAESTRO (bcrypt puro) ======

router.post('/login', express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ success:false, error:'Faltan credenciales' });
  }

  try {
    // busca por email insensible a may/min
    const rs = await db.query(
     `SELECT id, nombre, email, rol, password_hash AS password
         FROM usuarios
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email]
    );
    const u = rs.rows[0];
    if (!u) {
      return res.status(401).json({ success:false, error:'Credenciales incorrectas' });
    }

    // SOLO bcrypt (como antes)
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) {
      return res.status(401).json({ success:false, error:'Credenciales incorrectas' });
    }

    // (opcional) deja sesión para el portal si la usas
    if (req.session) {
      req.session.usuario_id  = u.id;
      req.session.usuario_rol = u.rol;
    }

    // mismo shape que tu front espera
    return res.json({
      success: true,
      usuario: { id: u.id, nombre: u.nombre || '', rol: u.rol || '' }
    });
  } catch (err) {
    console.error('POST /login error:', err);
    return res.status(500).json({ success:false, error:'Error en la base de datos' });
  }
});

router.get('/api/eventos', async (req, res) => {
  try {
    // 0) auth: id por sesión o query (compat)
    const usuarioId = Number(req.session?.usuario_id || req.query?.usuario_id);
    if (!usuarioId) return res.status(401).json({ error: 'auth_required' });

    // 1) usuario + rol
    const u = await db.query(
      `SELECT id, rol, email FROM usuarios WHERE id=$1 LIMIT 1`,
      [usuarioId]
    );
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error: 'usuario_not_found' });

    // 2) inspeccionar esquema de eventos
    const colsEvt = await db.query(`
      SELECT lower(column_name) AS c
      FROM information_schema.columns
      WHERE table_name='eventos'
    `);
    const E = new Set(colsEvt.rows.map(r => r.c));

    // columnas posibles (elige la que exista)
    const startCol  =
      E.has('fecha_inicio') ? 'fecha_inicio' :
      E.has('inicio')       ? 'inicio'       :
      E.has('start')        ? 'start'        : null;

    const endCol    =
      E.has('fecha_fin')    ? 'fecha_fin'    :
      E.has('fin')          ? 'fin'          :
      E.has('end')          ? 'end'          : null;

    const titleCol  =
      E.has('titulo')       ? 'titulo'       :
      E.has('title')        ? 'title'        :
      E.has('nombre')       ? 'nombre'       : null;

    const espacioCol =
      E.has('espacio')      ? 'espacio'      :
      E.has('lugar')        ? 'lugar'        :
      E.has('sala')         ? 'sala'         :
      E.has('ubicacion')    ? 'ubicacion'    : null;

    const hasGrupoId = E.has('grupo_id');

    // 3) detectar tabla de cruce evento↔grupo si no hay grupo_id en eventos
    const t = await db.query(`
      SELECT lower(table_name) AS t
      FROM information_schema.tables
      WHERE table_schema='public'
        AND lower(table_name) IN ('evento_grupo','eventos_grupos','evento_grupos','eventos_grupo')
    `);
    const T = new Set(t.rows.map(r => r.t));
    const crossTable =
      T.has('evento_grupo')   ? 'evento_grupo'   :
      T.has('eventos_grupos') ? 'eventos_grupos' :
      T.has('evento_grupos')  ? 'evento_grupos'  :
      T.has('eventos_grupo')  ? 'eventos_grupo'  : null;

    // columnas reales de la tabla de cruce (flex)
    let crossEventCol = null;
    let crossGroupCol = null;
    if (crossTable) {
      const crossCols = await db.query(`
        SELECT lower(column_name) AS c
        FROM information_schema.columns
        WHERE table_name=$1
      `, [crossTable]);
      const C = new Set(crossCols.rows.map(r => r.c));
      crossEventCol = C.has('evento_id')   ? 'evento_id'
                    : C.has('eventos_id')  ? 'eventos_id'
                    : C.has('event_id')    ? 'event_id'
                    : C.has('id_evento')   ? 'id_evento'
                    : null;
      crossGroupCol = C.has('grupo_id')    ? 'grupo_id'
                    : C.has('grupos_id')   ? 'grupos_id'
                    : C.has('id_grupo')    ? 'id_grupo'
                    : null;
      if (!crossEventCol || !crossGroupCol) {
        // si no podemos determinar columnas, ignoramos la tabla de cruce
        // (esto evitará errores y devolverá [] para docentes)
        crossEventCol = null;
        crossGroupCol = null;
      }
    }

    // 4) si es docente: obtener sus grupos
    let grupoIds = null; // null = sin filtro (admin); array = filtrar (docente)
    if (user.rol === 'docente') {
      const rp = await db.query(
        `SELECT id FROM profesores WHERE lower(email)=lower($1) LIMIT 1`,
        [user.email]
      );
      if (!rp.rowCount) return res.json([]); // docente sin vínculo → sin eventos
      const profesorId = rp.rows[0].id;

      const rg = await db.query(
        `SELECT g.id
           FROM profesor_grupo pg
           JOIN grupos g ON g.id = pg.grupo_id
          WHERE pg.profesor_id = $1`,
        [profesorId]
      );
      grupoIds = rg.rows.map(r => r.id);
      if (!grupoIds.length) return res.json([]); // sin grupos → sin eventos
    }

    // 5) construir SELECT normalizado
    const baseCols = [
      `e.id AS id`,
      `${titleCol ? `e.${titleCol}` : `'Evento'`} AS title`,
      `${startCol ? `e.${startCol}` : 'NULL'} AS start`,
      `${endCol   ? `e.${endCol}`   : 'NULL'} AS end`,
      `${espacioCol ? `e.${espacioCol}` : 'NULL'} AS espacio`
    ];

    let joins = '';
    // nombre del grupo si es posible
    if (hasGrupoId) {
      joins += ' LEFT JOIN grupos g ON g.id = e.grupo_id';
      baseCols.push('g.nombre AS grupo_nombre');
    } else if (crossTable && crossEventCol && crossGroupCol) {
      joins += ` LEFT JOIN ${crossTable} eg ON eg.${crossEventCol} = e.id`;
      joins += ` LEFT JOIN grupos g ON g.id = eg.${crossGroupCol}`;
      baseCols.push('g.nombre AS grupo_nombre');
    }

    let sql = `SELECT ${baseCols.join(', ')} FROM eventos e${joins}`;
    const where = [];
    const args = [];

    // filtro por grupos si es docente
    if (user.rol === 'docente') {
      if (hasGrupoId) {
        where.push(`e.grupo_id = ANY($${args.length + 1})`);
        args.push(grupoIds);
      } else if (crossTable && crossEventCol && crossGroupCol) {
        // forzamos JOIN real para filtrar (INNER) en vez de LEFT
        // (cambiamos el LEFT anterior por INNER sólo si filtramos)
        sql = sql.replace(`LEFT JOIN ${crossTable}`, `JOIN ${crossTable}`);
        where.push(`eg.${crossGroupCol} = ANY($${args.length + 1})`);
        args.push(grupoIds);
      } else {
        return res.json([]); // no hay forma de mapear evento↔grupo
      }
    }

    // filtro opcional por rango de fechas (FullCalendar pasa ?start=…&end=…)
    if (startCol) {
      const { start, end } = req.query || {};
      if (start) {
        where.push(`e.${startCol} >= $${args.length + 1}::timestamp`);
        args.push(start);
      }
      if (end) {
        where.push(`e.${startCol} <  $${args.length + 1}::timestamp`);
        args.push(end);
      }
    }

    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    // 6) orden razonable (sin mezclar tipos)
    if (startCol) {
      sql += ` ORDER BY e.${startCol} DESC NULLS LAST, e.id DESC`;
    } else {
      sql += ` ORDER BY e.id DESC`;
    }

    const { rows } = await db.query(sql, args);
    return res.json(rows);
  } catch (e) {
    console.error('GET /api/eventos error:', e);
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

router.get('/api/eventos/:id/alumnos', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
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
  } catch (err) {
    console.error('GET /api/eventos/:id/alumnos error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ────────────────────────── asistencias (historial, solo asignados) ────────────
router.get('/api/eventos/:id/asistencias', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  const fmtFecha = v => {
    if (!v && v !== 0) return '';
    const s = String(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  };
  const fmtHora = v => {
    if (!v && v !== 0) return '';
    const s = String(v);
    const m = s.match(/^(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : s;
  };

  try {
    const q = `
      SELECT
        a.nombre,
        a.apellidos,
        asi.fecha,
        asi.hora,
        asi.tipo,
        asi.ubicacion,
        COALESCE(asi.observaciones, '') AS observaciones
      FROM asistencias asi
      JOIN evento_asignaciones ea
        ON ea.evento_id = asi.evento_id
       AND ea.alumno_id = asi.alumno_id
      JOIN alumnos a
        ON a.id = asi.alumno_id
      WHERE asi.evento_id = $1
        AND (asi.tipo IS DISTINCT FROM 'ausente')  -- oculta antiguos "ausente"
      ORDER BY asi.fecha DESC NULLS LAST,
               asi.hora  DESC NULLS LAST,
               a.apellidos, a.nombre
    `;
    const rs = await db.query(q, [id]);

    const data = (rs.rows || []).map(r => ({
      nombre: r.nombre,
      apellidos: r.apellidos,
      fecha: fmtFecha(r.fecha),
      hora:  fmtHora(r.hora),
      tipo:  r.tipo || '',
      ubicacion: r.ubicacion || '',
      observaciones: r.observaciones || ''
    }));

    res.json(data);
  } catch (err) {
    console.error('GET /api/eventos/:id/asistencias error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────── firmar/guardar asistencias (solo asignados) ────────────

router.post('/api/firmar-alumnos', express.json(), async (req, res) => {
  const registros = Array.isArray(req.body?.registros) ? req.body.registros : [];
  if (!registros.length) return res.status(400).json({ success: false, ok: false, error: 'registros requeridos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ¿existe updated_at?
    const colsRs = await client.query(`
      SELECT lower(column_name) AS name
      FROM information_schema.columns
      WHERE table_name = 'asistencias'
    `);
    const cols = new Set(colsRs.rows.map(r => r.name));
    const hasUpdatedAt = cols.has('updated_at');

    let inserted = 0, updated = 0, deleted = 0, skipped = 0, notAssigned = 0;

    for (const r of registros) {
      const eventoId = Number(r.evento_id);
      const alumnoId = Number(r.alumno_id);
      const asistio  = !!r.asistio;
      const obs      = (r.observaciones || '').toString().slice(0, 500);

      if (!eventoId || !alumnoId) { skipped++; continue; }

      // Validar pertenencia
      const ea = await client.query(
        `SELECT 1 FROM evento_asignaciones WHERE evento_id = $1 AND alumno_id = $2`,
        [eventoId, alumnoId]
      );
      if (!ea.rowCount) { notAssigned++; continue; }

      if (asistio) {
        // Fuente = portal maestro ⇒ por defecto queremos 'manual'
        const tipoFinal = 'manual';

        // ¿existe ya?
        const ex = await client.query(
          `SELECT id FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]
        );

        if (ex.rowCount) {
          // UPDATE: pasamos 'manual' → sobrescribe el tipo anterior (p. ej., 'qr')
          const qUpd =
            `UPDATE asistencias
                SET fecha = CURRENT_DATE,
                    hora  = CURRENT_TIME,
                    observaciones = $3,
                    tipo = $4` +
            (hasUpdatedAt ? `, updated_at = NOW()` : ``) +
            ` WHERE evento_id = $1 AND alumno_id = $2`;
          await client.query(qUpd, [eventoId, alumnoId, obs, tipoFinal]);
          updated++;
        } else {
          // INSERT: 'manual'
          await client.query(
            `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, observaciones, tipo)
             VALUES ($1, $2, CURRENT_DATE, CURRENT_TIME, $3, $4)`,
            [eventoId, alumnoId, obs, tipoFinal]
          );
          inserted++;
        }
      } else {
        // Ausente ⇒ borrar (no generamos filas 'ausente')
        const del = await client.query(
          `DELETE FROM asistencias WHERE evento_id=$1 AND alumno_id=$2`,
          [eventoId, alumnoId]
        );
        deleted += del.rowCount;
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, ok: true, inserted, updated, deleted, skipped, notAssigned });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/firmar-alumnos error:', err);
    res.status(500).json({ success: false, ok: false, error: 'internal_error' });
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

// GET /api/mis-grupos?usuario_id=#
router.get('/api/mis-grupos', async (req, res) => {
  const usuarioId = Number(req.query.usuario_id);
  if (!usuarioId) return res.status(400).json({ error:'usuario_id requerido' });

  try {
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

    // otros roles: nada
    return res.json([]);
  } catch (e) {
    console.error('GET /api/mis-grupos', e);
    res.status(500).json({ error:'internal_error' });
  }
});
// POST /api/mensajes
// Body: { usuario_id, titulo, cuerpo, url, broadcast, grupos_nombres:[] }
router.post('/api/mensajes', express.json(), async (req, res) => {
  const {
    usuario_id,
    titulo,
    cuerpo,
    url,               // enlace opcional
    urls,              // puede venir como array o string JSON
    broadcast,         // boolean
    grupos_nombres,    // array opcional de nombres
    grupos_ids,        // array opcional de ids
    alumnos_ids        // array opcional de ids directos
  } = req.body || {};

  const usuarioId = Number(req.session?.usuario_id || usuario_id);
  if (!usuarioId) return res.status(400).json({ success:false, error:'usuario_id requerido' });
  if (!cuerpo || !String(cuerpo).trim()) return res.status(400).json({ success:false, error:'Mensaje vacío' });

  try {
    // 0) Usuario + rol
    const u = await db.query(`SELECT id, email, rol, nombre FROM usuarios WHERE id=$1 LIMIT 1`, [usuarioId]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ success:false, error:'usuario no encontrado' });

    // 1) Normaliza entrada
    const gruposSolicitados = Array.isArray(grupos_nombres) ? grupos_nombres.filter(Boolean) : [];
    const gruposIdsExtra    = Array.isArray(grupos_ids)     ? grupos_ids.map(Number).filter(Number.isInteger) : [];
    const alumnosIdsExtra   = Array.isArray(alumnos_ids)    ? alumnos_ids.map(Number).filter(Number.isInteger) : [];

    // 2) Construir “targets solicitados” con permisos
    let grupoIds = [];
    let alumnoIds = [];
    let isBroadcast = false;

    if (user.rol === 'admin') {
      if (broadcast) {
        isBroadcast = true;
      } else if (gruposSolicitados.length || gruposIdsExtra.length || alumnosIdsExtra.length) {
        if (gruposSolicitados.length) {
          const r = await db.query(`SELECT id FROM grupos WHERE nombre = ANY($1)`, [gruposSolicitados]);
          grupoIds = r.rows.map(x=>x.id);
        }
        if (gruposIdsExtra.length) grupoIds = [...new Set([...grupoIds, ...gruposIdsExtra])];
        if (alumnosIdsExtra.length) alumnoIds = [...new Set([...alumnoIds, ...alumnosIdsExtra])];
        if (!grupoIds.length && !alumnoIds.length) {
          return res.json({ success:true, enviados:0, info:'Sin grupos/alumnos válidos' });
        }
      } else {
        return res.status(400).json({ success:false, error:'Selecciona “Todos”, grupo(s) o alumno(s)' });
      }
    } else if (user.rol === 'docente') {
      if (broadcast) return res.status(403).json({ success:false, error:'Un docente no puede enviar a “Todos”' });

      const rp = await db.query(`SELECT id FROM profesores WHERE lower(email)=lower($1) LIMIT 1`, [user.email]);
      if (!rp.rowCount) return res.status(403).json({ success:false, error:'Docente no vinculado a profesores' });
      const profesorId = rp.rows[0].id;
      const rg = await db.query(
        `SELECT g.id, g.nombre
           FROM profesor_grupo pg
           JOIN grupos g ON g.id = pg.grupo_id
          WHERE pg.profesor_id = $1`,
        [profesorId]
      );
      const permitidosPorNombre = new Set(rg.rows.map(r => r.nombre));
      const permitidosPorId     = new Set(rg.rows.map(r => r.id));

      for (const nombre of (gruposSolicitados || [])) {
        if (!permitidosPorNombre.has(nombre)) {
          return res.status(403).json({ success:false, error:`No puedes enviar al grupo ${nombre}` });
        }
      }
      for (const gid of gruposIdsExtra) {
        if (!permitidosPorId.has(gid)) {
          return res.status(403).json({ success:false, error:`No puedes enviar al grupo ID ${gid}` });
        }
      }

      if (gruposSolicitados.length) {
        const r = await db.query(`SELECT id FROM grupos WHERE nombre = ANY($1)`, [gruposSolicitados]);
        grupoIds = r.rows.map(x=>x.id);
      }
      if (gruposIdsExtra.length) grupoIds = [...new Set([...grupoIds, ...gruposIdsExtra])];
      if (alumnosIdsExtra.length) alumnoIds = [...new Set([...alumnoIds, ...alumnosIdsExtra])];

      if (!grupoIds.length && !alumnoIds.length) {
        return res.status(400).json({ success:false, error:'Selecciona al menos un grupo o alumno' });
      }
    } else {
      return res.status(403).json({ success:false, error:'Rol no autorizado' });
    }

    // 3) Inserción en transacción
    const client = await db.connect();
    let mensajeId = null;
    try {
      await client.query('BEGIN');

      // 3.1) Insertar MENSAJE
      const tituloSafe = (titulo && String(titulo).trim()) || 'Aviso';

      // Normaliza urls a jsonb
      let urlsJsonb = null;
      if (Array.isArray(urls)) urlsJsonb = JSON.stringify(urls);
      else if (typeof urls === 'string' && urls.trim()) {
        try { urlsJsonb = JSON.stringify(JSON.parse(urls)); }
        catch { urlsJsonb = JSON.stringify([urls]); }
      }

      const cols = ['titulo','cuerpo','created_at'];
      const vals = ['$1','$2','NOW()'];
      const args = [tituloSafe, cuerpo];
      let i = 3;

      if (url)      { cols.push('url');  vals.push(`$${i}`); args.push(url);       i++; }
      if (urlsJsonb){ cols.push('urls'); vals.push(`$${i}::jsonb`); args.push(urlsJsonb); i++; }

      // autor si existe
      const autorCols = await client.query(`SELECT lower(column_name) AS c FROM information_schema.columns WHERE table_name='mensajes'`);
      const M = new Set(autorCols.rows.map(r=>r.c));
      const autorCol = M.has('usuario_id') ? 'usuario_id' : (M.has('creado_por') ? 'creado_por' : (M.has('autor_id') ? 'autor_id' : null));
      if (autorCol) { cols.push(autorCol); vals.push(`$${i}`); args.push(usuarioId); i++; }

      const insMsg = await client.query(
        `INSERT INTO mensajes (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id`,
        args
      );
      mensajeId = insMsg.rows[0]?.id;

      // 3.2) Registrar TARGETS en mensaje_destino (grupos / alumnos / broadcast)
      let insTargets = 0;

      if (isBroadcast) {
        await client.query(
          `INSERT INTO mensaje_destino (mensaje_id)
           SELECT $1
           WHERE NOT EXISTS (
             SELECT 1 FROM mensaje_destino WHERE mensaje_id=$1 AND grupo_id IS NULL AND alumno_id IS NULL
           )`,
          [mensajeId]
        );
        insTargets++;
      }

      if (grupoIds.length) {
        await client.query(
          `INSERT INTO mensaje_destino (mensaje_id, grupo_id)
           SELECT $1, v.gid
             FROM UNNEST($2::int[]) AS v(gid)
            WHERE NOT EXISTS (
              SELECT 1 FROM mensaje_destino md
               WHERE md.mensaje_id=$1 AND md.grupo_id = v.gid
            )`,
          [mensajeId, grupoIds]
        );
        insTargets += grupoIds.length;
      }

      if (alumnoIds.length) {
        await client.query(
          `INSERT INTO mensaje_destino (mensaje_id, alumno_id)
           SELECT $1, v.aid
             FROM UNNEST($2::int[]) AS v(aid)
            WHERE NOT EXISTS (
              SELECT 1 FROM mensaje_destino md
               WHERE md.mensaje_id=$1 AND md.alumno_id = v.aid
            )`,
          [mensajeId, alumnoIds]
        );
        insTargets += alumnoIds.length;
      }

      // 3.3) Fan-out a buzones (mensaje_entrega) → una fila por alumno
      const fanoutSql = `
        WITH dest_alumnos AS (
          -- alumnos directos
          SELECT md.alumno_id AS alumno_id
            FROM mensaje_destino md
           WHERE md.mensaje_id = $1 AND md.alumno_id IS NOT NULL

          UNION
          -- alumnos por grupos
          SELECT ag.alumno_id
            FROM mensaje_destino md
            JOIN alumno_grupo ag ON ag.grupo_id = md.grupo_id
           WHERE md.mensaje_id = $1 AND md.grupo_id IS NOT NULL

          UNION
          -- broadcast → todos los alumnos activos
          SELECT a.id
            FROM mensaje_destino md
            JOIN alumnos a ON a.activo = true
           WHERE md.mensaje_id = $1
             AND md.grupo_id IS NULL AND md.alumno_id IS NULL
        )
        INSERT INTO mensaje_entrega (mensaje_id, alumno_id, entregado_at)
        SELECT $1, da.alumno_id, NOW()
          FROM dest_alumnos da
         WHERE NOT EXISTS (
           SELECT 1 FROM mensaje_entrega me
            WHERE me.mensaje_id = $1 AND me.alumno_id = da.alumno_id
         );
      `;
      const fanout = await client.query(fanoutSql, [mensajeId]);

      await client.query('COMMIT');

      // 3.4) (FUERA de la TX) Enviar Web Push a los alumnos destino
      // Obtenemos los destinatarios finales
      const { rows: dests } = await db.query(`
        WITH dest_alumnos AS (
          SELECT md.alumno_id AS alumno_id
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
           WHERE md.mensaje_id = $1
             AND md.grupo_id IS NULL AND md.alumno_id IS NULL
        )
        SELECT DISTINCT alumno_id FROM dest_alumnos
      `, [mensajeId]);

      const alumnoIdsPush = dests.map(r => r.alumno_id);
      if (alumnoIdsPush.length) {
        const subs = await db.query(
          `SELECT endpoint, p256dh, auth
             FROM push_suscripciones
            WHERE alumno_id = ANY($1::int[])`,
          [alumnoIdsPush]
        );

        // Payload coherente con tu Service Worker
        const payload = {
          tipo: 'mensaje',
          mensaje_id: mensajeId,
          titulo: tituloSafe,
          cuerpo: cuerpo || '',
          url: url || null
          // si quieres, añade 'urls' también
        };

        for (const s of subs.rows) {
          try {
            const ret = await enviarPush(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              payload
            );
            if (ret === 'expired') {
              await db.query('DELETE FROM push_suscripciones WHERE endpoint = $1', [s.endpoint]);
            }
          } catch (e) {
            console.warn('Aviso: fallo enviando a un endpoint:', e?.statusCode || e?.message);
          }
        }
      }

      return res.json({
        success: true,
        mensaje_id: mensajeId,
        targets_registrados: isBroadcast ? 1 : (grupoIds.length + alumnoIds.length),
        entregas_creadas: (/* fanout puede venir undefined en algunos drivers */ 0) // no fiable cross-driver
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('POST /api/mensajes TX error:', e);
      return res.status(500).json({ success:false, error:'internal_error_tx' });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/mensajes', e);
    return res.status(500).json({ success:false, error:'internal_error' });
  }
});


module.exports = router;
