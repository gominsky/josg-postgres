const express = require('express');
const router = express.Router();
const db = require('../database/db');
const QRCode = require('qrcode');
const { toISODate } = require('../utils/fechas');
const { generarControlAsistenciaPDF } = require('../utils/pdfControlAsistencia');
// Helper: extrae {fechaISO, horaHHMM} desde un valor tipo "YYYY-MM-DDTHH:MM" o suelto
function splitISODateTime(input) {
  if (!input) return { fechaISO: null, horaHHMM: null };
  if (typeof input === 'string' && input.includes('T')) {
    const [d, t] = input.split('T');
    return { fechaISO: toISODate(d), horaHHMM: (t || '').slice(0, 5) || null };
  }
  return { fechaISO: toISODate(input), horaHHMM: null };
}
// Util para componer el PDF
const { pdfControlAsistencia } = require('../utils/pdfControlAsistencia');
// Listado JSON para FullCalendar (start/end normalizados)
router.get('/listado', async (req, res) => {
  const sql = `
    WITH e2 AS (
      SELECT
        e.*,
        CASE
          WHEN e.fecha_inicio ~ 'T'
            THEN to_timestamp(e.fecha_inicio, 'YYYY-MM-DD"T"HH24:MI')
          ELSE to_timestamp(e.fecha_inicio || ' ' || COALESCE(e.hora_inicio,'00:00'), 'YYYY-MM-DD HH24:MI')
        END AS start_ts,
        CASE
          WHEN e.fecha_fin ~ 'T'
            THEN to_timestamp(e.fecha_fin, 'YYYY-MM-DD"T"HH24:MI')
          ELSE to_timestamp(e.fecha_fin || ' ' || COALESCE(e.hora_fin,'00:00'), 'YYYY-MM-DD HH24:MI')
        END AS end_ts
      FROM eventos e
    )
    SELECT e2.id, e2.titulo, e2.descripcion, e2.grupo_id, e2.activo,
           g.nombre AS grupo_nombre,
           to_char(e2.start_ts, 'YYYY-MM-DD"T"HH24:MI') AS start_iso,
           to_char(e2.end_ts,   'YYYY-MM-DD"T"HH24:MI') AS end_iso
    FROM e2
    LEFT JOIN grupos g ON e2.grupo_id = g.id
  `;

  try {
    const { rows } = await db.query(sql);

    const cleanText = (text) =>
      (text || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B]/g, '').trim();

    const eventos = rows.map(row => {
      const tituloLimpio = cleanText(row.titulo);
      const grupoLimpio = cleanText(row.grupo_nombre || 'Sin grupo');
      const descripcionLimpia = cleanText(row.descripcion || '');

      return {
        id: row.id,
        title: tituloLimpio ? `${tituloLimpio} (${grupoLimpio})` : `Evento sin título`,
        start: row.start_iso,
        end: row.end_iso,
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
  } catch (err) {
    console.error('Error al obtener eventos:', err);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

// Vista principal: calendario o lista según parámetros (filtro con start_ts/end_ts)
router.get('/', async (req, res) => {
  const desdeRaw = req.query.desde || '';
  const hastaRaw = req.query.hasta || '';
  const desde = toISODate(desdeRaw);
  const hasta = toISODate(hastaRaw);

  if (desde && hasta) {
    const query = `
      WITH e2 AS (
        SELECT e.*,
          CASE
            WHEN e.fecha_inicio ~ 'T'
              THEN to_timestamp(e.fecha_inicio, 'YYYY-MM-DD"T"HH24:MI')
            ELSE to_timestamp(e.fecha_inicio || ' ' || COALESCE(e.hora_inicio,'00:00'), 'YYYY-MM-DD HH24:MI')
          END AS start_ts,
          CASE
            WHEN e.fecha_fin ~ 'T'
              THEN to_timestamp(e.fecha_fin, 'YYYY-MM-DD"T"HH24:MI')
            ELSE to_timestamp(e.fecha_fin || ' ' || COALESCE(e.hora_fin,'00:00'), 'YYYY-MM-DD HH24:MI')
          END AS end_ts
        FROM eventos e
      )
      SELECT e2.*, g.nombre AS grupo_nombre
      FROM e2
      JOIN grupos g ON e2.grupo_id = g.id
      WHERE e2.start_ts::date >= $1::date
        AND e2.end_ts::date   <= $2::date
      ORDER BY e2.start_ts
    `;

    try {
      const { rows: eventos } = await db.query(query, [desde, hasta]);
      const { rows: grupos } = await db.query('SELECT * FROM grupos ORDER BY nombre');
      res.render('eventos_lista', { eventos, grupos });
    } catch (error) {
      console.error('Error al obtener eventos entre fechas:', error);
      res.status(500).send('Error al obtener eventos');
    }
  } else {
    const grupos = (await db.query('SELECT * FROM grupos ORDER BY nombre')).rows;
    res.render('eventos_lista', { eventos: null, grupos });
  }
});

// Obtener evento por id (JSON)
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const result = await db.query('SELECT * FROM eventos WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al obtener el evento:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Crear evento
router.post('/', async (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;

  const activoValue = activo === '1' ? true : false;

  const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
  const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);

  if (!fIniISO || !fFinISO) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }

  const hora_inicio = hiFromIni || null;
  const hora_fin    = hfFromFin || null;
  const token = Math.random().toString(36).substring(2, 10); // 8 caracteres

  const sql = `
    INSERT INTO eventos (
      titulo, descripcion, fecha_inicio, fecha_fin, grupo_id,
      activo, hora_inicio, hora_fin, token
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `;

  const params = [
    titulo?.trim() || null,
    descripcion?.trim() || null,
    fIniISO,
    fFinISO,
    grupo_id,
    activoValue,
    hora_inicio,
    hora_fin,
    token
  ];

  try {
    const result = await db.query(sql, params);
    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error('Error al guardar evento:', err);
    res.status(500).json({ error: 'Error al guardar evento' });
  }
});

// Actualizar evento
router.put('/:id', async (req, res) => {
  const { titulo, descripcion, fecha_inicio, fecha_fin, grupo_id, activo } = req.body;
  const id = parseInt(req.params.id, 10);

  const activoValue = activo === '1' ? true : false;

  const { fechaISO: fIniISO, horaHHMM: hiFromIni } = splitISODateTime(fecha_inicio);
  const { fechaISO: fFinISO, horaHHMM: hfFromFin } = splitISODateTime(fecha_fin);

  if (!fIniISO || !fFinISO) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }

  const hora_inicio = hiFromIni || null;
  const hora_fin    = hfFromFin || null;

  const sql = `
    UPDATE eventos
    SET titulo = $1,
        descripcion = $2,
        fecha_inicio = $3,
        fecha_fin = $4,
        grupo_id = $5,
        activo = $6,
        hora_inicio = $7,
        hora_fin = $8
    WHERE id = $9
  `;

  const params = [
    titulo?.trim() || null,
    descripcion?.trim() || null,
    fIniISO,
    fFinISO,
    grupo_id,
    activoValue,
    hora_inicio,
    hora_fin,
    id
  ];

  try {
    await db.query(sql, params);
    res.json({ updated: true });
  } catch (err) {
    console.error('Error al actualizar evento:', err);
    res.status(500).json({ error: 'Error al actualizar evento' });
  }
});

// Eliminar evento (y su guardia si existe)
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    // 1. Borrar guardias relacionadas
    await db.query('DELETE FROM guardias WHERE evento_id = $1', [id]);

    // 2. Borrar asistencias
    await db.query('DELETE FROM asistencias WHERE evento_id = $1', [id]);

    // 3. Borrar evento
    await db.query('DELETE FROM eventos WHERE id = $1', [id]);

    res.json({ deleted: true });
  } catch (err) {
    console.error('Error al eliminar evento:', err);
    res.status(500).json({ error: 'Error al eliminar evento' });
  }
});

// QR del evento
router.get('/:id/qr', async (req, res) => {
  const eventoId = req.params.id;

  const eventoSQL = `
    SELECT e.*, g.nombre AS grupo_nombre
    FROM eventos e
    JOIN grupos g ON e.grupo_id = g.id
    WHERE e.id = $1
  `;

  try {
    const { rows } = await db.query(eventoSQL, [eventoId]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');

    const evento = rows[0];

    // const qrData = `https://tuservidor.com/firmar/${evento.id}?token=${evento.token}`;
    const qrData = JSON.stringify({ evento_id: evento.id, token: evento.token });
    const qrDataUrl = await QRCode.toDataURL(qrData);

    // Construir Date a partir de fecha ISO + hora HH:MM si existe
    const fISO = toISODate(evento.fecha_inicio);
    const hhmm = (evento.hora_inicio || '00:00');
    const fechaObj = fISO ? new Date(`${fISO}T${hhmm}:00`) : null;

    const fechaFormateada = fechaObj
      ? fechaObj.toLocaleString('es-ES', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : (evento.fecha_inicio || '');

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
              background: white,
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
              button { display: none; }
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
  } catch (err) {
    console.error('Error generando el QR:', err);
    res.status(500).send('Error generando el QR');
  }
});

// Mostrar formulario de firma manual
// Mostrar formulario de firma manual (backend limpia fecha/hora y ordena alumnos)
router.get('/:id/firma_manual', async (req, res) => {
  const eventoId = parseInt(req.params.id, 10);
  if (isNaN(eventoId)) return res.status(400).send('ID inválido');

  const eventoSQL = `
    SELECT e.*, g.nombre AS grupo_nombre
    FROM eventos e
    JOIN grupos g ON g.id = e.grupo_id
    WHERE e.id = $1
  `;

  const alumnosSQL = `
    SELECT a.*, 
           CASE WHEN asi.alumno_id IS NOT NULL THEN 1 ELSE 0 END AS firmado
    FROM alumnos a
    LEFT JOIN asistencias asi 
      ON a.id = asi.alumno_id AND asi.evento_id = $1
    JOIN alumno_grupo ag ON ag.alumno_id = a.id
    WHERE ag.grupo_id = $2
    ORDER BY a.apellidos, a.nombre
  `;

  try {
    const { rows: eventoRows } = await db.query(eventoSQL, [eventoId]);
    if (eventoRows.length === 0) return res.status(404).send('Evento no encontrado');

    const evento = eventoRows[0];
    if (!evento.grupo_id) return res.status(400).send('Grupo del evento no definido');

    const { rows: alumnos } = await db.query(alumnosSQL, [eventoId, evento.grupo_id]);

    // ---- Orden “es” sin tocar BD (ignora tildes, respeta ñ)
    const coll = new Intl.Collator('es', { sensitivity: 'base' });
    alumnos.sort((a, b) => {
      const ap = coll.compare(a.apellidos || '', b.apellidos || '');
      if (ap) return ap;
      const no = coll.compare(a.nombre || '', b.nombre || '');
      if (no) return no;
      return (a.id || 0) - (b.id || 0);
    });

    // ---- Formateo de fecha/hora para la vista
    const toISO = v => (v ? String(v).split('T')[0] : '');
    const fechaISO = toISO(evento.fecha_inicio);
    const horaIni = (evento.hora_inicio || '').slice(0, 5) || null;
    const horaFin = (evento.hora_fin || '').slice(0, 5) || null;

    let iniTxt = evento.fecha_inicio || '—';
    let hIni = horaIni || '—';
    let hFin = horaFin || '—';

    if (fechaISO) {
      const d = new Date(`${fechaISO}T${horaIni || '00:00'}:00`);
      iniTxt = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
    }

    const firmados = alumnos.filter(a => a.firmado).map(a => a.id);

    res.render('firma_manual', { evento, alumnos, firmados, iniTxt, hIni, hFin });
  } catch (err) {
    console.error('Error al cargar formulario de firmas:', err);
    res.status(500).send('Error al cargar formulario de firmas');
  }
});


// Guardar firmas manuales (post completo)
router.post('/:id/firma_manual', async (req, res) => {
  const eventoId = parseInt(req.params.id);
  const firmadosActuales = req.body.alumnosFirmados || [];

  const nuevosFirmados = Array.isArray(firmadosActuales)
    ? firmadosActuales.map(id => parseInt(id))
    : [parseInt(firmadosActuales)];

  try {
    const { rows: registrosActuales } = await db.query(
      'SELECT alumno_id FROM asistencias WHERE evento_id = $1',
      [eventoId]
    );
    const actualesIds = registrosActuales.map(r => r.alumno_id);

    const aInsertar = nuevosFirmados.filter(id => !actualesIds.includes(id));
    const aEliminar = actualesIds.filter(id => !nuevosFirmados.includes(id));

    const tareas = [];
    for (const id of aInsertar) {
      tareas.push(db.query('INSERT INTO asistencias (evento_id, alumno_id) VALUES ($1, $2)', [eventoId, id]));
    }
    for (const id of aEliminar) {
      tareas.push(db.query('DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2', [eventoId, id]));
    }

    await Promise.all(tareas);
    res.redirect(`/eventos/${eventoId}/firma_manual`);
  } catch (err) {
    console.error('Error actualizando asistencias:', err);
    res.status(500).send('Error actualizando asistencias');
  }
});

// Guardar firma/unfirma vía AJAX
router.post('/:id/firma_manual/ajax', async (req, res) => {
  const eventoId = parseInt(req.params.id, 10);
  const alumnoId = parseInt(req.body.alumno_id, 10);
  const firmado = req.body.firmado === 'true';

  if (!eventoId || !alumnoId) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const insertSQL = `INSERT INTO asistencias (evento_id, alumno_id) VALUES ($1, $2)`;
  const deleteSQL = `DELETE FROM asistencias WHERE evento_id = $1 AND alumno_id = $2`;

  try {
    if (firmado) {
      await db.query(insertSQL, [eventoId, alumnoId]);
    } else {
      await db.query(deleteSQL, [eventoId, alumnoId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando firma' });
  }
});

router.get('/:id/firmas.pdf', async (req, res, next) => {
  try {
    const eventoId = Number(req.params.id);
    if (!Number.isInteger(eventoId)) return res.status(400).send('ID no válido');
    await pdfControlAsistencia(db, res, eventoId);
  } catch (err) {
    next(err);
  }
});
module.exports = router;
