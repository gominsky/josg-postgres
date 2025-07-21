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

    // Comparar usando bcrypt
    bcrypt.compare(password, user.password, (err, result) => {
      if (err || !result) {
        return res.json({ success: false, error: 'Contraseña incorrecta' });
      }
      
      // Éxito
      res.json({
        success: true,
        usuario_id: user.id,
        nombre: user.nombre || 'docente',
        rol: user.rol
      });
    });
  });
});

// GET /api/eventos?usuario_id=...
router.get('/api/eventos', (req, res) => {
  const usuarioId = req.query.usuario_id;
  if (!usuarioId) return res.status(400).json([]);

  // 1) Obtenemos el rol de ese usuario
  db.get(
    'SELECT rol FROM usuarios WHERE id = ?',
    [usuarioId],
    (err, row) => {
      if (err) return res.status(500).json([]);
      if (!row) return res.json([]);

      const rol = row.rol;
      let sql, params = [];

      if (rol === 'admin') {
        // 2a) Si es admin, sacamos todos los eventos
        sql = `
          SELECT e.id, e.titulo, e.fecha_inicio, e.fecha_fin, g.nombre AS grupo_nombre
          FROM eventos e
          JOIN grupos g ON e.grupo_id = g.id
          ORDER BY e.fecha_inicio ASC
        `;
      } else {
        // 2b) Si no es admin (docente), sacamos sólo los suyos
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

      // 3) Ejecutamos la consulta seleccionada
      db.all(sql, params, (err2, eventos) => {
        if (err2) return res.status(500).json([]);

        // 4) Adaptamos para FullCalendar
        const eventosAdaptados = eventos.map(e => ({
          id:    e.id,
          title: `${e.titulo} (${e.grupo_nombre})`,
          start: e.fecha_inicio,
          end:   e.fecha_fin
        }));

        res.json(eventosAdaptados);
      });
    }
  );
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
    LEFT JOIN asistencias asi ON asi.evento_id = e.id AND asi.alumno_id = a.id AND asi.tipo = 'manual'
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

  registros.forEach(({ evento_id, alumno_id, asistio, observaciones }) => {
    const verificarSQL = `SELECT id FROM asistencias WHERE evento_id = ? AND alumno_id = ? AND tipo = 'manual'`;

    db.get(verificarSQL, [evento_id, alumno_id], (err, row) => {
      if (err) {
        errores.push({ alumno_id, error: 'Error de lectura' });
        done();
      } else if (asistio && !row) {
        // Insertar si no existe
        const insertSQL = `
          INSERT INTO asistencias (evento_id, alumno_id, fecha, hora, tipo, observaciones)
          VALUES (?, ?, DATE('now'), TIME('now'), 'manual', ?)
        `;
        db.run(insertSQL, [evento_id, alumno_id, observaciones || ''], err2 => {
          if (err2) errores.push({ alumno_id, error: 'No se pudo insertar' });
          done();
        });
      } else if (!asistio && row) {
        // Eliminar si existe y está desmarcado
        const deleteSQL = `DELETE FROM asistencias WHERE id = ?`;
        db.run(deleteSQL, [row.id], err3 => {
          if (err3) errores.push({ alumno_id, error: 'No se pudo eliminar' });
          done();
        });
      } else if (asistio && row) {
        // Actualizar observación
        const updateSQL = `UPDATE asistencias SET observaciones = ? WHERE id = ?`;
        db.run(updateSQL, [observaciones || '', row.id], err4 => {
          if (err4) errores.push({ alumno_id, error: 'No se pudo actualizar' });
          done();
        });
      } else {
        done(); // Nada que hacer
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

// PATCH: Activar o desactivar QR
router.patch('/api/eventos/:id/activar', (req, res) => {
  const eventoId = req.params.id;
  const { activo } = req.body;

  const sql = `UPDATE eventos SET activo = ? WHERE id = ?`;
  db.run(sql, [activo ? 1 : 0, eventoId], function (err) {
    if (err) return res.status(500).json({ success: false, error: 'No se pudo actualizar' });
    res.json({ success: true });
  });
});
module.exports = router;
