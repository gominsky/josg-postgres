const express = require('express');
const router = express.Router();
const db = require('../database/db'); // → instancia de pg.Pool
const bcrypt = require('bcrypt');

router.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Faltan credenciales' });

  try {
    const result = await db.query(
      `SELECT * FROM usuarios WHERE email = $1 AND rol IN ('docente', 'admin')`,
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.json({ success: false, error: 'Credenciales inválidas' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, error: 'Credenciales inválidas' });

    res.json({ success: true, usuario: { id: user.id, nombre: user.nombre, rol: user.rol } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
router.get('/api/eventos', async (req, res) => {
  const usuarioId = parseInt(req.query.usuario_id, 10);
  if (isNaN(usuarioId)) return res.status(400).json([]);
  if (!usuarioId) return res.status(400).json([]);

  try {
    const rolRes = await db.query('SELECT rol FROM usuarios WHERE id = $1', [usuarioId]);
    if (rolRes.rowCount === 0) return res.json([]);

    const rol = rolRes.rows[0].rol;
    let sql, params = [];

    if (rol === 'admin') {
      sql = `
        SELECT e.id, e.titulo, e.fecha_inicio, e.fecha_fin, g.nombre AS grupo_nombre
        FROM eventos e
        JOIN grupos g ON e.grupo_id = g.id
        ORDER BY e.fecha_inicio ASC
      `;
    } else {
      sql = `
        SELECT e.id, e.titulo, e.fecha_inicio, e.fecha_fin, g.nombre AS grupo_nombre
        FROM eventos e
        JOIN grupos g ON e.grupo_id = g.id
        JOIN profesor_grupo pg ON pg.grupo_id = g.id
        JOIN profesores p ON p.id = pg.profesor_id
        JOIN usuarios u ON u.email = p.email
        WHERE u.id = $1
        ORDER BY e.fecha_inicio ASC
      `;
      params = [usuarioId];
    }

    const eventosRes = await db.query(sql, params);

    const eventosAdaptados = eventosRes.rows.map(e => ({
      id: e.id,
      title: `${e.titulo} (${e.grupo_nombre})`,
      start: e.fecha_inicio,
      end: e.fecha_fin
    }));

    res.json(eventosAdaptados);
  } catch (err) {
    console.error('❌ Error en /api/eventos:', err.message);
    res.status(500).json([]);
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
router.post('/api/firmar-alumnos', async (req, res) => {
  const registros = req.body.registros;
  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ success: false, error: 'No se han enviado asistencias' });
  }

  const errores = [];
  // hora/fecha ya convertidas a Europa/Madrid (ver sección B)
  const nowMadrid = ` (now() at time zone 'Europe/Madrid') `;
  for (const { evento_id, alumno_id, asistio, tipo, ubicacion } of registros) {
    try {
      const result = await db.query(
        `SELECT id FROM asistencias WHERE evento_id = $1 AND alumno_id = $2`,
        [evento_id, alumno_id]
      );
      const existente = result.rows[0];

      // Validar tipo: 'qr' o 'manual' (default)
      const tipoSeg = (tipo === 'qr') ? 'qr' : 'manual';

      if (asistio) {
        if (!existente) {
          await db.query(
            `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, ubicacion, observaciones)
             VALUES ($1, $2, (${nowMadrid})::date, (${nowMadrid})::time, $3, $4, '')`,
            [evento_id, alumno_id, tipoSeg, ubicacion || null]
          );
        } else {
          await db.query(
            `UPDATE asistencias
               SET tipo = $2,
                   fecha = (${nowMadrid})::date,
                   hora  = (${nowMadrid})::time,
                   ubicacion = COALESCE($3, ubicacion)
             WHERE id = $1`,
            [existente.id, tipoSeg, ubicacion || null]
          );
        }
      } else {
        if (existente) {
          await db.query(`DELETE FROM asistencias WHERE id = $1`, [existente.id]);
        }
      }
    } catch (err) {
      console.error('⚠️ Error al procesar asistencia:', err);
      errores.push({ alumno_id, error: 'Error en el registro' });
    }
  }
  res.json({ success: true, errores });
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
// control_firmas.js — NUEVO endpoint
router.post('/api/firmar-qr', async (req, res) => {
  const { evento_id, alumno_id, token, ubicacion } = req.body;

  if (!evento_id || !alumno_id || !token) {
    return res.status(400).json({ success: false, error: 'Faltan datos (evento_id, alumno_id, token)' });
  }

  try {
    // 1) Validar evento, activo y token
    const ev = await db.query(
      `SELECT id, activo, token FROM eventos WHERE id = $1`,
      [evento_id]
    );
    const evento = ev.rows[0];
    if (!evento) return res.status(404).json({ success: false, error: 'Evento no encontrado' });
    if (!evento.activo) return res.status(403).json({ success: false, error: 'QR desactivado' });
    if (evento.token !== token) return res.status(403).json({ success: false, error: 'Token inválido' });

    // 2) Upsert de asistencia como 'qr' con hora Madrid
    const nowMadrid = ` (now() at time zone 'Europe/Madrid') `;
    const existe = await db.query(
      `SELECT id FROM asistencias WHERE evento_id = $1 AND alumno_id = $2`,
      [evento_id, alumno_id]
    );

    if (!existe.rows[0]) {
      await db.query(
        `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, ubicacion, observaciones)
         VALUES ($1, $2, (${nowMadrid})::date, (${nowMadrid})::time, 'qr', $3, '')`,
        [evento_id, alumno_id, ubicacion || null]
      );
    } else {
      await db.query(
        `UPDATE asistencias
            SET tipo='qr',
                fecha=(${nowMadrid})::date,
                hora =(${nowMadrid})::time,
                ubicacion = COALESCE($3, ubicacion)
          WHERE id=$1`,
        [existe.rows[0].id, ubicacion || null]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error firmar-qr:', err);
    return res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;