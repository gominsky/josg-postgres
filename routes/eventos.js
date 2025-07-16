const express = require('express');
const router = express.Router();
const db = require('../database/db');
const QRCode = require('qrcode');

// Listado JSON para FullCalendar
router.get('/listado', (req, res) => {
  const sql = `
    SELECT eventos.id, eventos.titulo, eventos.descripcion, eventos.fecha_inicio, eventos.fecha_fin, eventos.grupo_id, grupos.nombre AS grupo_nombre
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

// Crear evento
router.post('/', (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id } = req.body;
  const sql = `INSERT INTO eventos (titulo, descripcion, fecha_inicio, fecha_fin, grupo_id) VALUES (?, ?, ?, ?, ?)`;
  const params = [titulo, descripcion, fecha_inicio, fecha_fin, grupo_id];

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: 'Error al guardar evento' });
    res.json({ id: this.lastID });
  });
});

// Actualizar evento
router.put('/:id', (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id } = req.body;
  const sql = `
    UPDATE eventos
    SET titulo = ?, descripcion = ?, fecha_inicio = ?, fecha_fin = ?, grupo_id = ?
    WHERE id = ?
  `;
  db.run(sql, [titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, req.params.id], function (err) {
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

  const sql = `SELECT id, token, titulo, fecha_inicio FROM eventos WHERE id = ?`;
  db.get(sql, [eventoId], async (err, evento) => {
    if (err || !evento) return res.status(404).send('Evento no encontrado');

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

module.exports = router;