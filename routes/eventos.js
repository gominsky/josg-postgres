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

    const eventos = rows.map(row => ({
      id: row.id,
      title: `${row.titulo} (${row.grupo_nombre || 'Sin grupo'})`,
      start: row.fecha_inicio,
      end: row.fecha_fin,
      descripcion: row.descripcion,
      grupo_id: row.grupo_id,
      grupo: row.grupo_nombre,
      activo: row.activo,
      backgroundColor: '#2a4b7c',
      borderColor: '#2a4b7c'
    }));

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
      res.render('eventos_lista', { eventos, desde, hasta, grupos: [], hero: false });
    });
  } else {
    // Si no hay parámetros, mostrar calendario con grupos
    db.all('SELECT * FROM grupos', (err, grupos) => {
      if (err) return res.status(500).send('Error al cargar grupos');
      res.render('eventos_lista', { eventos: null, desde: '', hasta: '', grupos, hero: false });
    });
  }
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
            <a href="/eventos/${evento.id}" style="text-decoration:none;color:#007bff;">Volver al evento</a>
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
                background-color: #007bff;
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
  const alumnosSQL = `
    SELECT a.*
    FROM alumnos a
    JOIN alumno_grupo ag ON ag.alumno_id = a.id
    WHERE ag.grupo_id = ? AND a.activo = 1
    ORDER BY a.apellidos, a.nombre
  `;
  const asistenciasSQL = `
    SELECT alumno_id FROM asistencias WHERE evento_id = ?
  `;

  db.get(eventoSQL, [eventoId], (err, evento) => {
    if (err || !evento) return res.status(500).send('Error cargando evento');

    db.all(alumnosSQL, [evento.grupo_id], (err, alumnos) => {
      if (err) return res.status(500).send('Error cargando alumnos');

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
  const { alumnosFirmados } = req.body; // array de IDs

  const fecha = new Date().toISOString().split('T')[0];
  const hora = new Date().toTimeString().split(' ')[0];

  const ids = Array.isArray(alumnosFirmados) ? alumnosFirmados : [alumnosFirmados];

  const insert = db.prepare(`
    INSERT INTO asistencias (alumno_id, evento_id, fecha, hora, tipo)
    VALUES (?, ?, ?, ?, 'manual')
  `);

  ids.forEach(id => {
    insert.run(id, eventoId, fecha, hora);
  });

  insert.finalize(err => {
    if (err) return res.status(500).send('Error al guardar firmas');
    res.redirect(`/eventos/${eventoId}/firma_manual`);
  });
});

module.exports = router;