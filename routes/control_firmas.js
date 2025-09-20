const express = require('express');
const router = express.Router();
const db = require('../database/db'); // → instancia de pg.Pool
const bcrypt = require('bcrypt');

router.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Faltan credenciales' });

  try {
    // Selecciona el hash correcto y aliaséalo como "password"
    const result = await db.query(
      `SELECT id, nombre, rol, password_hash AS password
       FROM usuarios
       WHERE email = $1 AND rol IN ('docente', 'admin')`,
      [email]
    );

    const user = result.rows[0];
    if (!user) return res.json({ success: false, error: 'Credenciales inválidas' });

    // Protégete si el usuario no tiene hash
    if (!user.password) {
      return res.json({
        success: false,
        error: 'La cuenta no tiene contraseña configurada. Contacta con un admin.'
      });
    }

    const match = await bcrypt.compare(String(password), String(user.password));
    if (!match) return res.json({ success: false, error: 'Credenciales inválidas' });

    res.json({ success: true, usuario: { id: user.id, nombre: user.nombre, rol: user.rol } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// GET /api/eventos → feed común para calendario y carteles
// GET /api/eventos  (soporta con y sin ?usuario_id=)
router.get('/api/eventos', async (req, res) => {
  const usuarioId = Number(req.query.usuario_id) || null;

  try {
    let result;

    if (usuarioId) {
      // Si viene usuario → versión filtrada por usuario/rol
      // Ajusta la vista/joins según tu esquema real
      result = await db.query(`
        SELECT
          e.id,
          e.titulo        AS title,
          e.fecha_inicio  AS start,
          e.fecha_fin     AS "end"
        FROM vw_eventos_por_usuario e
        WHERE e.usuario_id = $1
        ORDER BY e.fecha_inicio ASC
        LIMIT 200
      `, [usuarioId]);
    } else {
      // Sin usuario → versión general (próximos 90 días)
      // ATENCIÓN: usa tu tabla real. Si tu /_diag contó en "eventos", este SELECT debería pegar ahí.
      result = await db.query(`
        SELECT
          id,
          titulo        AS title,
          fecha_inicio  AS start,
          fecha_fin     AS "end"
        FROM eventos
        WHERE fecha_inicio >= NOW() - INTERVAL '7 days'
          AND fecha_inicio  < NOW() + INTERVAL '90 days'
        ORDER BY fecha_inicio ASC
        LIMIT 200
      `);
    }

    // Normaliza a ISO "YYYY-MM-DDTHH:mm:ss" por si el driver devuelve Date
    const rows = (result.rows || []).map(ev => ({
      id: ev.id,
      title: ev.title,
      start: new Date(ev.start).toISOString().slice(0,19),
      end:   new Date(ev.end).toISOString().slice(0,19),
    }));

    // Log útil en Render para confirmar cuántos salen
    console.log('[API] /api/eventos ->', rows.length, 'eventos');
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/eventos error:', err);
    return res.status(500).json([]);
  }
});

router.get('/api/eventos/:id', async (req, res) => {
  const eventoId = req.params.id;
  try {
    const result = await db.query(`
      SELECT e.*, g.nombre AS grupo_nombre
      FROM eventos e
      JOIN grupos g ON e.grupo_id = g.id
      WHERE e.id = $1
    `, [eventoId]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener evento' });
  }
});
router.get('/api/eventos/:id/alumnos', async (req, res) => {
  const eventoId = req.params.id;
  const sql = `
    SELECT a.id, a.nombre, a.apellidos,
      CASE WHEN asi.id IS NOT NULL THEN true ELSE false END AS asistio,
      asi.observaciones
    FROM alumnos a
    JOIN alumno_grupo ag ON ag.alumno_id = a.id
    JOIN eventos e ON e.grupo_id = ag.grupo_id
    LEFT JOIN asistencias asi ON asi.evento_id = e.id AND asi.alumno_id = a.id 
    WHERE e.id = $1 AND a.activo = true
    ORDER BY a.apellidos, a.nombre
  `;
  try {
    const result = await db.query(sql, [eventoId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});
// control_firmas.js  (reemplaza el handler de POST /api/firmar-alumnos)
// Reemplaza TODO el handler por este
router.post('/api/firmar-alumnos', async (req, res) => {
  const registros = req.body?.registros;
  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ success: false, error: 'No se han enviado asistencias' });
  }

  const nowMadrid = " (now() at time zone 'Europe/Madrid') ";
  const errores = [];

  for (const r of registros) {
    // Normaliza tipos
    const evento_id  = Number(r.evento_id);
    const alumno_id  = Number(r.alumno_id);
    const asistio    = !!r.asistio;
    const tipoSeg    = (r.tipo === 'qr') ? 'qr' : 'manual';
    const ubicacion  = (r.ubicacion == null || r.ubicacion === '') ? null : String(r.ubicacion);

    if (!evento_id || !alumno_id) {
      errores.push({ alumno_id, error: 'evento_id/alumno_id inválidos' });
      continue;
    }

    try {
      // ¿ya hay asistencia?
      const existe = await db.query(
        `SELECT id FROM asistencias
          WHERE evento_id = $1::int AND alumno_id = $2::int`,
        [evento_id, alumno_id]
      );

      if (asistio) {
        if (existe.rowCount === 0) {
          // INSERT nuevo (observaciones vacío para mantener compatibilidad)
          await db.query(
            `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, ubicacion, observaciones)
             VALUES ($1::int, $2::int, (${nowMadrid})::date, (${nowMadrid})::time, $3::text, $4::text, '')`,
            [evento_id, alumno_id, tipoSeg, ubicacion]
          );
        } else {
          // UPDATE existente: refresca fecha/hora/tipo; mantiene ubicación si no mandas nada
          await db.query(
            `UPDATE asistencias
                SET tipo  = $2::text,
                    fecha = (${nowMadrid})::date,
                    hora  = (${nowMadrid})::time,
                    ubicacion = COALESCE($3::text, ubicacion)
              WHERE id = $1::int`,
            [Number(existe.rows[0].id), tipoSeg, ubicacion]
          );
        }
      } else {
        // Desmarcar asistencia (borrar fila si existía)
        if (existe.rowCount > 0) {
          await db.query(`DELETE FROM asistencias WHERE id = $1::int`, [Number(existe.rows[0].id)]);
        }
      }
    } catch (err) {
      console.error('⚠️ Error al procesar asistencia:', err.message);
      errores.push({ alumno_id, error: 'Error en el registro' });
    }
  }

  return res.json({ success: true, errores });
});
router.patch('/api/eventos/:id/activar', async (req, res) => {
  const eventoId = req.params.id;
  const { activo } = req.body;

  try {
    await db.query(`UPDATE eventos SET activo = $1 WHERE id = $2`, [activo, eventoId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'No se pudo actualizar' });
  }
});
router.patch('/api/eventos/:id/observaciones-generales', async (req, res) => {
  const eventoId = req.params.id;
  const { observaciones } = req.body;

  try {
    await db.query(`UPDATE eventos SET observaciones = $1 WHERE id = $2`, [observaciones, eventoId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'No se pudo actualizar observaciones' });
  }
});
router.get('/api/eventos/:id/asistencias', async (req, res) => {
  const eventoId = req.params.id;

  try {
    const result = await db.query(`
      SELECT a.nombre, a.apellidos, asi.fecha, asi.hora, asi.tipo, asi.ubicacion
      FROM asistencias asi
      JOIN alumnos a ON a.id = asi.alumno_id
      WHERE asi.evento_id = $1
      ORDER BY asi.fecha DESC, asi.hora DESC
    `, [eventoId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener asistencias' });
  }
});
// Lista de grupos para mensajes
// Nueva ruta: devuelve solo los nombres de los grupos
router.get('/api/grupos', async (req, res) => {
  try {
    const result = await db.query('SELECT nombre FROM grupos ORDER BY nombre ASC');
    const nombres = result.rows.map(r => r.nombre);
    res.json(nombres); // Ejemplo: ["Cuerdas", "Metales", "Percusión"]
  } catch (err) {
    console.error('❌ Error en /api/grupos:', err.message);
    res.status(500).json({ error: 'Error al obtener grupos' });
  }
});
// routes/control_firmas.js
router.get('/api/_diag', async (req, res) => {
  try {
    const u = await db.query('SELECT COUNT(*)::int n FROM usuarios');
    const e = await db.query('SELECT COUNT(*)::int n FROM eventos');
    res.json({ ok:true, usuarios:u.rows[0].n, eventos:e.rows[0].n, ts:Date.now() });
  } catch (err) {
    res.status(500).json({ ok:false, error:String(err) });
  }
});

module.exports = router;