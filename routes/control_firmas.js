const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt'); 

router.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: 'Faltan credenciales' });
  }

  const sql = `SELECT * FROM usuarios WHERE email = ? AND rol IN ('docente', 'admin')`;

  db.get(sql, [email], (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Error de servidor' });
    if (!user) return res.json({ success: false, error: 'Usuario no encontrado o sin permiso' });

    bcrypt.compare(password, user.password, (err, result) => {
      if (err || !result) {
        return res.json({ success: false, error: 'Contraseña incorrecta' });
      }

      res.json({
        success: true,
        usuario_id: user.id,
        nombre: user.nombre || 'docente',
        rol: user.rol
      });
    });
  });
});

router.get('/api/eventos', (req, res) => {
  const usuarioId = req.query.usuario_id;
  if (!usuarioId) return res.status(400).json([]);

  db.get('SELECT rol FROM usuarios WHERE id = ?', [usuarioId], (err, row) => {
    if (err) return res.status(500).json([]);
    if (!row) return res.json([]);

    const rol = row.rol;
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
        WHERE u.id = ?
        ORDER BY e.fecha_inicio ASC
      `;
      params = [usuarioId];
    }

    db.all(sql, params, (err2, eventos) => {
      if (err2) return res.status(500).json([]);

      const eventosAdaptados = eventos.map(e => ({
        id: e.id,
        title: `${e.titulo} (${e.grupo_nombre})`,
        start: e.fecha_inicio,
        end: e.fecha_fin
      }));

      res.json(eventosAdaptados);
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

router.get('/api/eventos/:id/alumnos', (req, res) => {
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

  db.all(sql, [eventoId], (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

router.post('/api/firmar-alumnos', (req, res) => {
  const registros = req.body.registros;

  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ success: false, error: 'No se han enviado asistencias' });
  }

  let procesados = 0;
  const errores = [];

  registros.forEach(({ evento_id, alumno_id, asistio }) => {
    const verificarSQL = `SELECT id, tipo FROM asistencias WHERE evento_id = ? AND alumno_id = ?`;

    db.get(verificarSQL, [evento_id, alumno_id], (err, row) => {
      if (err) {
        errores.push({ alumno_id, error: 'Error de lectura' });
        done();
      } else if (asistio && !row) {
        const insertSQL = `
          INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, observaciones)
          VALUES (?, ?, DATE('now'), TIME('now'), 'manual', '')
        `;
        db.run(insertSQL, [evento_id, alumno_id], err2 => {
          if (err2) errores.push({ alumno_id, error: 'No se pudo insertar' });
          done();
        });
      } else if (!asistio && row && row.tipo === 'manual') {
        const deleteSQL = `DELETE FROM asistencias WHERE id = ?`;
        db.run(deleteSQL, [row.id], err3 => {
          if (err3) errores.push({ alumno_id, error: 'No se pudo eliminar' });
          done();
        });
      } else {
        done();
      }
    });
  });

  function done() {
    procesados++;
    if (procesados === registros.length) {
      res.json({ success: true, errores });
    }
  }
});

router.patch('/api/eventos/:id/activar', (req, res) => {
  const eventoId = req.params.id;
  const { activo } = req.body;

  const sql = `UPDATE eventos SET activo = ? WHERE id = ?`;
  db.run(sql, [activo ? 1 : 0, eventoId], function (err) {
    if (err) return res.status(500).json({ success: false, error: 'No se pudo actualizar' });
    res.json({ success: true });
  });
});

// PATCH: Actualizar observaciones generales del evento
router.patch('/api/eventos/:id/observaciones-generales', (req, res) => {
  const eventoId = req.params.id;
  const { observaciones } = req.body;

  const sql = `UPDATE eventos SET observaciones_generales = ? WHERE id = ?`;
  db.run(sql, [observaciones, eventoId], function (err) {
    if (err) {
      console.error('Error actualizando observaciones generales:', err);
      return res.status(500).json({ success: false, error: 'No se pudo actualizar observaciones' });
    }
    res.json({ success: true });
  });
});
router.get('/api/eventos/:id/asistencias', (req, res) => {
  const eventoId = req.params.id;

  const sql = `
    SELECT a.nombre, a.apellidos, asi.fecha, asi.hora, asi.tipo, asi.ubicacion
    FROM asistencias asi
    JOIN alumnos a ON a.id = asi.alumno_id
    WHERE asi.evento_id = ?
    ORDER BY asi.fecha DESC, asi.hora DESC
  `;

  db.all(sql, [eventoId], (err, filas) => {
    if (err) return res.status(500).json({ error: 'Error al obtener asistencias' });
    res.json(filas);
  });
});

module.exports = router;
