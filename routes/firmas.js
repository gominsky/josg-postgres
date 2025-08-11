const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Ruta 1: Registro de alumno si ya existe (email + DNI)
router.post('/registro-app', async (req, res) => {
  const { email, dni, password } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM alumnos WHERE email = $1 AND dni = $2',
      [email, dni]
    );
    const alumno = result.rows[0];

    if (!alumno) {
      return res.status(404).json({ error: 'No existe un alumno con ese email y DNI' });
    }

    if (alumno.registrado) {
      return res.status(400).json({ error: 'Este alumno ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query(
        'UPDATE alumnos SET password = $1, registrado = $2 WHERE id = $3',
        [hash, true, alumno.id]
      );

    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('Error en registro-app:', err);
    res.status(500).json({ error: 'Error al registrar al alumno' });
  }
});

// Ruta 2: Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM alumnos WHERE email = $1 AND registrado = true',
      [email]
    );
    const alumno = result.rows[0];

    if (!alumno) {
      return res.status(404).json({ error: 'Alumno no encontrado o no registrado' });
    }

    const coincide = await bcrypt.compare(password, alumno.password);
    if (!coincide) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error en la base de datos' });
  }
});

// Ruta 3: Firma de asistencia con QR
router.post('/', async (req, res) => {
  const { alumno_id, evento_id, token, ubicacion } = req.body;
  try {
    const eventoRes = await db.query(
      'SELECT * FROM eventos WHERE id = $1 AND token = $2 AND activo IS TRUE',
      [evento_id, token]
    );
    const evento = eventoRes.rows[0];
    if (!evento) {
      return res.status(400).json({ error: 'Evento no válido o inactivo' });
    }

    const checkRes = await db.query(
      'SELECT COUNT(*) AS total FROM asistencias WHERE alumno_id = $1 AND evento_id = $2',
      [alumno_id, evento_id]
    );

    if (parseInt(checkRes.rows[0].total) > 0) {
      return res.status(400).json({ error: 'Ya se ha firmado asistencia para este evento' });
    }

    const now = new Date();
    const fecha = now.toISOString().split('T')[0];
    const hora = now.toTimeString().split(' ')[0];

    await db.query(
      `INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo, ubicacion)
       VALUES ($1, $2, $3, $4, 'qr', $5)`,
      [alumno_id, evento_id, fecha, hora, ubicacion]
    );

    res.json({ success: true, mensaje: 'Asistencia registrada correctamente' });
  } catch (err) {
    console.error('Error al registrar asistencia:', err);
    res.status(500).json({ error: 'Error al registrar la asistencia' });
  }
});

module.exports = router;
