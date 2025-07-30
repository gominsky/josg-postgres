const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// 🔐 Login para docentes y admins
router.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: 'Faltan credenciales' });
  }

  try {
    const row = await db.getAsync(
      `SELECT * FROM usuarios WHERE email = ? AND rol IN ('docente', 'admin')`,
      [email]
    );

    if (!row) return res.json({ success: false, error: 'Credenciales inválidas' });

    const match = await bcrypt.compare(password, row.password);
    if (!match) return res.json({ success: false, error: 'Credenciales inválidas' });

    res.json({ success: true, usuario: { id: row.id, nombre: row.nombre, rol: row.rol } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// 📅 Obtener detalle de evento
router.get('/api/eventos/:id', async (req, res) => {
  const eventoId = req.params.id;

  try {
    const evento = await db.getAsync(`
      SELECT e.*, g.nombre AS grupo_nombre
      FROM eventos e
      JOIN grupos g ON e.grupo_id = g.id
      WHERE e.id = ?
    `, [eventoId]);

    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    res.json(evento);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener evento' });
  }
});

// 👥 Obtener alumnos del evento
router.get('/api/eventos/:id/alumnos', async (req, res) => {
  const eventoId = req.params.id;

  const sql = `
    SELECT a.id, a.nombre, a.apellidos,
      CASE WHEN asi.id IS NOT NULL THEN 1 ELSE 0 END AS asistio,
      asi.observaciones
    FROM alumnos a
    JOIN alumno_grupo ag ON ag.alumno_id = a.id
    JOIN eventos e ON e.grupo_id = ag.grupo_id
    LEFT JOIN asistencias asi ON asi.evento_id = e.id AND asi.alumno_id = a.id 
    WHERE e.id = ? AND a.activo = 1
    ORDER BY a.apellidos, a.nombre
  `;

  try {
    const rows = await db.allAsync(sql, [eventoId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// ✍️ Registrar asistencias manuales
router.post('/api/firmar-alumnos', async (req, res) => {
  const registros = req.body.registros;

  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ success: false, error: 'No se han enviado asistencias' });
  }

  const errores = [];

  for (const { evento_id, alumno_id, asistio } of registros) {
    try {
      const existente = await db.getAsync(
        `SELECT id, tipo FROM asistencias WHERE evento_id = ? AND alumno_id = ?`,
        [evento_id, alumno_id]
      );

      if (asistio && !existente) {
        await db.runAsync(
          `INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, observaciones)
           VALUES (?, ?, DATE('now'), TIME('now'), 'manual', '')`,
          [evento_id, alumno_id]
        );
      } else if (!asistio && existente?.tipo === 'manual') {
        await db.runAsync(`DELETE FROM asistencias WHERE id = ?`, [existente.id]);
      }
    } catch (err) {
      errores.push({ alumno_id, error: 'Error en el registro' });
    }
  }

  res.json({ success: true, errores });
});

// 🔄 Activar / desactivar evento
router.patch('/api/eventos/:id/activar', async (req, res) => {
  const eventoId = req.params.id;
  const { activo } = req.body;

  try {
    await db.runAsync(`UPDATE eventos SET activo = ? WHERE id = ?`, [activo ? 1 : 0, eventoId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'No se pudo actualizar' });
  }
});

// 📝 Actualizar observaciones generales
router.patch('/api/eventos/:id/observaciones-generales', async (req, res) => {
  const eventoId = req.params.id;
  const { observaciones } = req.body;

  try {
    await db.runAsync(`UPDATE eventos SET observaciones_generales = ? WHERE id = ?`, [observaciones, eventoId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'No se pudo actualizar observaciones' });
  }
});

// 📄 Ver lista de asistencias por evento
router.get('/api/eventos/:id/asistencias', async (req, res) => {
  const eventoId = req.params.id;

  try {
    const filas = await db.allAsync(`
      SELECT a.nombre, a.apellidos, asi.fecha, asi.hora, asi.tipo, asi.ubicacion
      FROM asistencias asi
      JOIN alumnos a ON a.id = asi.alumno_id
      WHERE asi.evento_id = ?
      ORDER BY asi.fecha DESC, asi.hora DESC
    `, [eventoId]);

    res.json(filas);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener asistencias' });
  }
});

module.exports = router;
