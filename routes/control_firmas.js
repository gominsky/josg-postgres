const express = require('express');
const router = express.Router();
const db = require('../database/db');

// LOGIN DE PROFESORES (usando tabla usuarios con rol='profesor')
router.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: 'Faltan credenciales' });
  }

  const sql = `SELECT * FROM usuarios WHERE email = ? AND rol = 'profesor'`;

  db.get(sql, [email], (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Error de servidor' });
    if (!user) return res.json({ success: false, error: 'Usuario no encontrado o sin permiso' });

    if (user.password !== password) {
      return res.json({ success: false, error: 'Contraseña incorrecta' });
    }

    res.json({
      success: true,
      usuario_id: user.id,
      nombre: user.nombre || 'Profesor',
      rol: user.rol
    });
  });
});

// OBTENER EVENTOS ASIGNADOS AL PROFESOR
router.get('/api/eventos', (req, res) => {
  const usuarioId = req.query.usuario_id;
  if (!usuarioId) return res.status(400).json([]);

  const sql = `
    SELECT e.id, e.titulo, e.fecha_inicio, e.fecha_fin, g.nombre AS grupo_nombre
    FROM eventos e
    JOIN grupos g ON e.grupo_id = g.id
    JOIN profesor_grupo pg ON pg.grupo_id = g.id
    JOIN profesores p ON p.id = pg.profesor_id
    JOIN usuarios u ON u.email = p.email
    WHERE u.id = ?
    ORDER BY e.fecha_inicio ASC
  `;

  db.all(sql, [usuarioId], (err, eventos) => {
    if (err) return res.status(500).json([]);
    res.json(eventos);
  });
});
router.post('/api/firmar', (req, res) => {
    const { usuario_id, evento_id } = req.body;
    if (!usuario_id || !evento_id) return res.status(400).json({ success: false, error: 'Datos incompletos' });
  
    // 1. Obtener el ID del profesor asociado al usuario
    const obtenerProfesorId = `
      SELECT p.id FROM profesores p
      JOIN usuarios u ON u.email = p.email
      WHERE u.id = ?
    `;
  
    db.get(obtenerProfesorId, [usuario_id], (err, profesor) => {
      if (err || !profesor) return res.json({ success: false, error: 'Profesor no encontrado' });
  
      const profesorId = profesor.id;
  
      // 2. Verificar si ya firmó
      const verificar = `
        SELECT 1 FROM asistencias
        WHERE evento_id = ? AND alumno_id = ? AND tipo = 'profesor'
      `;
  
      db.get(verificar, [evento_id, profesorId], (err2, existente) => {
        if (err2) return res.status(500).json({ success: false, error: 'Error al verificar firma' });
  
        if (existente) {
          return res.json({ success: false, error: 'Ya has firmado este evento' });
        }
  
        // 3. Insertar firma
        const insertar = `
          INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, ubicacion)
          VALUES (?, ?, DATE('now'), TIME('now'), 'profesor', 'firma manual')
        `;
  
        db.run(insertar, [evento_id, profesorId], function (err3) {
          if (err3) return res.json({ success: false, error: 'No se pudo guardar la firma' });
          res.json({ success: true });
        });
      });
    });
  });  
  
router.get('/api/eventos/:id', (req, res) => {
  const eventoId = req.params.id;

  const sql = `
    SELECT e.*, g.nombre AS grupo_nombre
    FROM eventos e
    JOIN grupos g ON e.grupo_id = g.id
    WHERE e.id = ?
  `;

  db.get(sql, [eventoId], (err, evento) => {
    if (err || !evento) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(evento);
  });
});
// GET /control_firmas/api/asistencias?usuario_id=XX
router.get('/api/asistencias', (req, res) => {
    const usuarioId = req.query.usuario_id;
    if (!usuarioId) return res.status(400).json([]);
  
    const sql = `
      SELECT e.titulo, g.nombre AS grupo_nombre, a.fecha, a.hora
      FROM asistencias a
      JOIN eventos e ON a.evento_id = e.id
      JOIN grupos g ON e.grupo_id = g.id
      JOIN profesores p ON p.id = a.alumno_id
      JOIN usuarios u ON u.email = p.email
      WHERE u.id = ? AND a.tipo = 'profesor'
      ORDER BY a.fecha DESC, a.hora DESC
    `;
  
    db.all(sql, [usuarioId], (err, filas) => {
      if (err) return res.status(500).json([]);
      res.json(filas);
    });
  });
  
module.exports = router;
