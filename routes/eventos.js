const express = require('express');
const router = express.Router();
const db = require('../database/db');
const QRCode = require('qrcode');

// Listado JSON para FullCalendar
router.get('/listado', (req, res) => {
  const sql = `
    SELECT eventos.id, eventos.titulo, eventos.descripcion, eventos.fecha_inicio, eventos.fecha_fin, eventos.grupo_id, eventos.activo, grupos.nombre AS grupo_nombre
    FROM eventos
    LEFT JOIN grupos ON eventos.grupo_id = grupos.id
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error al obtener eventos' });
    const cleanText = (text) =>
      (text || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B]/g, '').trim();
    
      const eventos = rows.map((row) => {
      const tituloLimpio = cleanText(row.titulo);
      const grupoLimpio = cleanText(row.grupo_nombre || 'Sin grupo');
      const descripcionLimpia = cleanText(row.descripcion || '');
    
      return {
        id: row.id,
        title: tituloLimpio ? `${tituloLimpio} (${grupoLimpio})` : `Evento sin título`,
        start: row.fecha_inicio,
        end: row.fecha_fin,
        titulo: tituloLimpio,
        descripcion: descripcionLimpia,
        grupo_id: row.grupo_id,
        grupo: grupoLimpio,
        activo: row.activo,
        backgroundColor: '#2a4b7c',
        borderColor: '#2a4b7c'
      };
    });

    res.json(eventos);
  });
});

// Vista principal: calendario o lista según parámetros
router.get('/', (req, res) => {
  const desde = req.query.desde || '';
  const hasta = req.query.hasta || '';

  // Si se piden eventos entre fechas, mostrar lista
  if (desde && hasta) {
    const query = `
      SELECT e.*, g.nombre AS grupo_nombre
      FROM eventos e
      JOIN grupos g ON e.grupo_id = g.id
      WHERE DATE(e.fecha_inicio) >= DATE(?) AND DATE(e.fecha_fin) <= DATE(?)
      ORDER BY e.fecha_inicio
    `;
    db.all(query, [desde, hasta], (err, eventos) => {
      if (err) return res.status(500).send('Error al obtener eventos');

      // Cargamos los grupos también
      db.all('SELECT * FROM grupos', (err, grupos) => {
        if (err) return res.status(500).send('Error al cargar grupos');
        res.render('eventos_lista', { eventos, desde, hasta, grupos, hero: false });
      });
    });
  } else {
    // Si no hay fechas, mostrar solo el calendario
    db.all('SELECT * FROM grupos', (err, grupos) => {
      if (err) return res.status(500).send('Error al cargar grupos');
      res.render('eventos_lista', { eventos: null, desde: '', hasta: '', grupos, hero: false });
    });
  }
});

router.get('/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM eventos WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Error al obtener el evento:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
    if (!row) return res.status(404).json({ error: 'Evento no encontrado' });

    res.json(row);
  });
});

// Crear evento con hora_inicio, hora_fin y token QR
router.post('/', (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;
  const activoValue = activo === '1' ? 1 : 0;
  // Extraer solo la hora de las fechas
  const hora_inicio = fecha_inicio?.split('T')[1]?.slice(0, 5) || null; // formato "HH:MM"
  const hora_fin = fecha_fin?.split('T')[1]?.slice(0, 5) || null;
  // Generar token aleatorio
  const token = Math.random().toString(36).substring(2, 10); // 8 caracteres
  const sql = `
    INSERT INTO eventos (titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo, hora_inicio, hora_fin, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    titulo,
    descripcion,
    fecha_inicio,
    fecha_fin,
    grupo_id,
    activoValue,
    hora_inicio,
    hora_fin,
    token
  ];

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: 'Error al guardar evento' });
    res.json({ id: this.lastID });
  });
});

// Actualizar evento
router.put('/:id', (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;
const activoValue = activo === '1' ? 1 : 0;
const sql = `
  UPDATE eventos
  SET titulo = ?, descripcion = ?, fecha_inicio = ?, fecha_fin = ?, grupo_id = ?, activo = ?
  WHERE id = ?
`;
db.run(sql, [titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activoValue, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: 'Error al actualizar evento' });
    res.json({ updated: true });
  });
});

// Eliminar evento
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM eventos WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: 'Error al eliminar evento' });
    res.json({ deleted: true });
  });
});

//Generar QR
router.get('/:id/qr', (req, res) => {
  const eventoId = req.params.id;

  const sql = `SELECT id, token, titulo, fecha_inicio, activo FROM eventos WHERE id = ?`;
  db.get(sql, [eventoId], async (err, evento) => {
    if (err || !evento) return res.status(404).send('Evento no encontrado');

    if (!evento.activo) {
      return res.status(403).send(`
        <html>
          <head><title>QR desactivado</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
            <h2>QR desactivado</h2>
            <p>Este evento no tiene activo el sistema de escaneo QR.</p>
            <a href="/eventos/" style="text-decoration:none;color:#FF9501;">Volver al evento</a>
          </body>
        </html>
      `);
    }
    const payload = {
      evento_id: evento.id,
      token: evento.token
    };

    try {
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload));

      const fechaFormateada = new Date(evento.fecha_inicio).toLocaleString('es-ES', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      res.send(`
        <html>
          <head>
            <title>QR para ${evento.titulo}</title>
            <style>
              body {
                font-family: sans-serif;
                text-align: center;
                background: #f4f4f4;
                padding: 2rem;
              }
              .qr-container {
                background: white;
                display: inline-block;
                padding: 2rem;
                border-radius: 1rem;
                box-shadow: 0 0 10px rgba(0,0,0,0.1);
              }
              img {
                width: 300px;
                height: 300px;
              }
              button {
                margin-top: 1.5rem;
                padding: 0.8rem 2rem;
                font-size: 1rem;
                border: none;
                border-radius: 0.5rem;
                background-color: #FF9501;
                color: white;
                cursor: pointer;
              }
              @media print {
                button {
                  display: none;
                }
              }
            </style>
          </head>
          <body>
            <div class="qr-container">
              <h2>${evento.titulo}</h2>
              <p><strong>${fechaFormateada}</strong></p>
              <img src="${qrDataUrl}" alt="QR Evento" />
              <p style="margin-top:1rem;color:gray;">Escanéalo con la app del alumno</p>
              <button onclick="window.print()">Imprimir QR</button>
            </div>
          </body>
        </html>
      `);
    } catch (error) {
      res.status(500).send('Error generando el QR');
    }
  });
});

// Mostrar formulario de firma manual
router.get('/:id/firma_manual', (req, res) => {
  const eventoId = req.params.id;

  const eventoSQL = `SELECT * FROM eventos WHERE id = ?`;
  const asistenciasSQL = `SELECT alumno_id FROM asistencias WHERE evento_id = ?`;

  db.get(eventoSQL, [eventoId], (err, evento) => {
    if (err || !evento) return res.status(500).send('Error cargando evento');

    const alumnosSQL = `
      SELECT a.*
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = ?
        AND DATE(a.fecha_matriculacion) <= DATE(?)
        AND (a.fecha_baja IS NULL OR DATE(a.fecha_baja) >= DATE(?))
      ORDER BY a.apellidos, a.nombre
    `;

    db.all(alumnosSQL, [evento.grupo_id, evento.fecha_inicio, evento.fecha_inicio], (err, alumnos) => {
      if (err) {
        console.error("Error SQL alumnos:", err.message);
        return res.status(500).send('Error cargando alumnos');
      }

      db.all(asistenciasSQL, [eventoId], (err, asistencias) => {
        if (err) return res.status(500).send('Error cargando asistencias');

        const firmados = asistencias.map(a => a.alumno_id);
        res.render('firma_manual', { evento, alumnos, firmados });
      });
    });
  });
});

router.post('/:id/firma_manual', (req, res) => {
  const eventoId = req.params.id;
  const firmadosActuales = req.body.alumnosFirmados || [];

  // Normalizar a array (cuando solo hay uno, puede venir como string)
  const nuevosFirmados = Array.isArray(firmadosActuales)
    ? firmadosActuales.map(id => parseInt(id))
    : [parseInt(firmadosActuales)];

  // Primero obtenemos todos los firmados actuales en la BBDD
  const getSQL = `SELECT alumno_id FROM asistencias WHERE evento_id = ?`;
  db.all(getSQL, [eventoId], (err, registrosActuales) => {
    if (err) return res.status(500).send('Error al obtener asistencias');

    const actualesIds = registrosActuales.map(r => r.alumno_id);

    // Determinar cuáles eliminar y cuáles insertar
    const aInsertar = nuevosFirmados.filter(id => !actualesIds.includes(id));
    const aEliminar = actualesIds.filter(id => !nuevosFirmados.includes(id));

    // Transacciones simples para insertar y eliminar
    const insertSQL = `INSERT INTO asistencias (evento_id, alumno_id) VALUES (?, ?)`;
    const deleteSQL = `DELETE FROM asistencias WHERE evento_id = ? AND alumno_id = ?`;

    const tareas = [];

    aInsertar.forEach(id => {
      tareas.push(new Promise((resolve, reject) => {
        db.run(insertSQL, [eventoId, id], err => {
          if (err) reject(err);
          else resolve();
        });
      }));
    });

    aEliminar.forEach(id => {
      tareas.push(new Promise((resolve, reject) => {
        db.run(deleteSQL, [eventoId, id], err => {
          if (err) reject(err);
          else resolve();
        });
      }));
    });

    // Ejecutar todas las tareas
    Promise.all(tareas)
      .then(() => res.redirect(`/eventos/${eventoId}/firma_manual`))
      .catch(error => {
        console.error("Error actualizando asistencias:", error);
        res.status(500).send('Error actualizando asistencias');
      });
  });
});

router.post('/:id/firma_manual/ajax', (req, res) => {
  const eventoId = parseInt(req.params.id);
  const alumnoId = parseInt(req.body.alumno_id);
  const firmado = req.body.firmado === 'true';

  if (!eventoId || !alumnoId) return res.status(400).json({ error: 'Datos inválidos' });

  const insertSQL = `INSERT INTO asistencias (evento_id, alumno_id) VALUES (?, ?)`;
  const deleteSQL = `DELETE FROM asistencias WHERE evento_id = ? AND alumno_id = ?`;

  const sql = firmado ? insertSQL : deleteSQL;
  const params = firmado ? [eventoId, alumnoId] : [eventoId, alumnoId];

  db.run(sql, params, function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error actualizando firma' });
    }
    res.json({ success: true });
  });
});

module.exports = router;