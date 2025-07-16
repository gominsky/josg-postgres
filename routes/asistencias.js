const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Ruta 1: Registro de alumno si ya existe (email + DNI)
router.post('/registro-app', async (req, res) => {
  const { email, dni, password } = req.body;

  db.get(`SELECT * FROM alumnos WHERE email = ? AND dni = ?`, [email, dni], async (err, alumno) => {
    if (err) return res.status(500).json({ error: 'Error al acceder a la base de datos' });

    if (!alumno) {
      return res.status(404).json({ error: 'No existe un alumno con ese email y DNI' });
    }

    if (alumno.registrado) {
      return res.status(400).json({ error: 'Este alumno ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const sql = `UPDATE alumnos SET password = ?, registrado = 1 WHERE id = ?`;

    db.run(sql, [hash, alumno.id], function (err) {
      if (err) return res.status(500).json({ error: 'Error al registrar al alumno' });
      res.json({ success: true, alumno_id: alumno.id });
    });
  });
});

// Ruta 2: Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  db.get(`SELECT * FROM alumnos WHERE email = ? AND registrado = 1`, [email], async (err, alumno) => {
    if (err) return res.status(500).json({ error: 'Error en la base de datos' });
    if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado o no registrado' });

    const coincide = await bcrypt.compare(password, alumno.password);
    if (!coincide) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    res.json({ success: true, alumno_id: alumno.id });
  });
});

// Ruta 3: Firma de asistencia con QR
router.post('/', (req, res) => {
  const { alumno_id, evento_id, token, ubicacion } = req.body;

  // Validar evento y token
  const eventoSQL = `SELECT * FROM eventos WHERE id = ? AND token = ? AND activo = 1`;
  db.get(eventoSQL, [evento_id, token], (err, evento) => {
    if (err || !evento) return res.status(400).json({ error: 'Evento no válido o inactivo' });

    // Verificar si ya firmó
    const checkSQL = `SELECT * FROM asistencias WHERE alumno_id = ? AND evento_id = ?`;
    db.get(checkSQL, [alumno_id, evento_id], (err, asistenciaExistente) => {
      if (asistenciaExistente) {
        return res.status(400).json({ error: 'Ya se ha firmado asistencia para este evento' });
      }

      const fecha = new Date().toISOString().split('T')[0];
      const hora = new Date().toLocaleTimeString();

      const insertSQL = `
        INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo)
        VALUES (?, ?, ?, ?, ?, 'qr')
      `;

      db.run(insertSQL, [alumno_id, evento_id, fecha, hora], function (err) {
        if (err) return res.status(500).json({ error: 'Error al registrar la asistencia' });
        res.json({ success: true, mensaje: 'Asistencia registrada correctamente' });
      });
    });
  });
});

// Ruta 4: Firma manual (por parte del profesor)
router.post('/manual', (req, res) => {
  const { alumno_id, evento_id } = req.body;

  // Validar que el alumno pertenece al grupo del evento
  const sql = `
    SELECT 1
    FROM eventos e
    JOIN alumno_grupo ag ON ag.grupo_id = e.grupo_id
    WHERE e.id = ? AND ag.alumno_id = ?
  `;

  db.get(sql, [evento_id, alumno_id], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ error: 'El alumno no pertenece al grupo del evento' });
    }

    // Verificar si ya firmó
    const checkSQL = `SELECT * FROM asistencias WHERE alumno_id = ? AND evento_id = ?`;
    db.get(checkSQL, [alumno_id, evento_id], (err, asistenciaExistente) => {
      if (asistenciaExistente) {
        return res.status(400).json({ error: 'Ya se ha firmado asistencia para este evento' });
      }

      const fecha = new Date().toISOString().split('T')[0];
      const hora = new Date().toLocaleTimeString();

      const insertSQL = `
        INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo)
        VALUES (?, ?, ?, ?, 'manual')
      `;

      db.run(insertSQL, [alumno_id, evento_id, fecha, hora], function (err) {
        if (err) return res.status(500).json({ error: 'Error al registrar asistencia manual' });
        res.json({ success: true, mensaje: 'Asistencia manual registrada' });
      });
    });
  });
});

module.exports = router;
