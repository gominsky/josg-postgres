const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');

// Registro (sin cambios)
router.post('/registro-app', async (req, res) => {
  const { email, dni, password } = req.body;
  try {
    const r = await db.query('SELECT * FROM alumnos WHERE email = $1 AND dni = $2', [email, dni]);
    const alumno = r.rows[0];
    if (!alumno) return res.status(404).json({ error: 'No existe un alumno con ese email y DNI' });
    if (alumno.registrado) return res.status(400).json({ error: 'Este alumno ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE alumnos SET password = $1, registrado = $2 WHERE id = $3', [hash, true, alumno.id]);
    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('registro-app:', err);
    res.status(500).json({ error: 'Error al registrar al alumno' });
  }
});

// Login (sin cambios)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await db.query('SELECT * FROM alumnos WHERE email = $1 AND registrado = true', [email]);
    const alumno = r.rows[0];
    if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado o no registrado' });

    const ok = await bcrypt.compare(password, alumno.password);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

    res.json({ success: true, alumno_id: alumno.id });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ error: 'Error en la base de datos' });
  }
});

// ------- SOLO QR --------
async function insertarAsistenciaMadrid({ alumno_id, evento_id, ubicacion }) {
  const ex = await db.query(
    'SELECT id FROM asistencias WHERE alumno_id = $1 AND evento_id = $2',
    [alumno_id, evento_id]
  );
  if (ex.rows[0]) return { yaFirmado: true };

  const nowMadrid = " (now() at time zone 'Europe/Madrid') ";
  // Inserta con hora/fecha desde Postgres (zona Madrid)
  await db.query(
    `INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo, ubicacion)
     VALUES ($1, $2, (${nowMadrid})::date, (${nowMadrid})::time, 'qr', $3)`,
    [alumno_id, evento_id, ubicacion || null]
  );
  return { yaFirmado: false };
}
async function handleFirmarQR(req, res) {
  try {
    const { alumno_id, evento_id, token, ubicacion } = req.body || {};
    if (!alumno_id || !evento_id || !token) {
      return res.status(400).json({ success: false, mensaje: 'Faltan datos (alumno_id, evento_id, token)' });
    }

    // Validar evento activo + token
    const ev = await db.query(
      'SELECT id FROM eventos WHERE id = $1 AND token = $2 AND activo IS TRUE',
      [evento_id, token]
    );
    if (!ev.rows[0]) {
      return res.status(400).json({ success: false, mensaje: 'Evento no válido o inactivo' });
    }

    const r = await insertarAsistenciaMadrid({ alumno_id: Number(alumno_id), evento_id: Number(evento_id), ubicacion });

    if (r.yaFirmado) {
      // Idempotente: 200 OK pero informamos que ya estaba
      return res.json({
        success: true,
        yaFirmado: true,
        mensaje: 'Asistencia ya estaba registrada para este evento'
      });
    }

    return res.json({
      success: true,
      yaFirmado: false,
      mensaje: 'Asistencia registrada correctamente'
    });

  } catch (err) {
    console.error('firmar-qr:', err);
    return res.status(500).json({ success: false, mensaje: 'Error interno' });
  }
}
router.post('/firmar-qr', handleFirmarQR);
// Alias para compatibilidad con apps que llamaban POST /firmas/
router.post('/', handleFirmarQR);

module.exports = router;
