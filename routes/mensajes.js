const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { enviarPush } = require('../utils/push');

/**
 * Crear mensaje desde el panel.
 * body: { titulo, cuerpo, url?, grupos?: [id], alumnos?: [id], broadcast?: boolean }
 */

router.post('/', async (req, res) => {
  const { titulo, cuerpo, url, grupos = [], alumnos = [], broadcast = false } = req.body;

  if (!titulo || !cuerpo) return res.status(400).json({ error: 'Faltan campos' });

  try {
    await db.query('BEGIN');

    const { rows } = await db.query(
      'INSERT INTO mensajes (titulo, cuerpo, url) VALUES ($1,$2,$3) RETURNING id',
      [titulo, cuerpo, url || null]
    );
    const mensajeId = rows[0].id;

    // Guardar targets
    if (broadcast) {
      await db.query('INSERT INTO mensaje_destino (mensaje_id) VALUES ($1)', [mensajeId]);
    }
    if (Array.isArray(grupos) && grupos.length) {
      const vals = grupos.map((g, i) => `($1, $${i+2})`).join(',');
      await db.query(`INSERT INTO mensaje_destino (mensaje_id, grupo_id) VALUES ${vals}`, [mensajeId, ...grupos]);
    }
    if (Array.isArray(alumnos) && alumnos.length) {
      const vals = alumnos.map((a, i) => `($1, $${i+2})`).join(',');
      await db.query(`INSERT INTO mensaje_destino (mensaje_id, alumno_id) VALUES ${vals}`, [mensajeId, ...alumnos]);
    }

    // Resolver destinatarios finales (alumnos)
    const destinatarios = await db.query(`
      WITH base AS (
        SELECT $1::int AS mensaje_id
      ),
      universo AS (
        SELECT a.id AS alumno_id FROM alumnos a WHERE a.activo = 1
      ),
      t_broadcast AS (
        SELECT TRUE AS hay FROM mensaje_destino WHERE mensaje_id = $1 AND grupo_id IS NULL AND alumno_id IS NULL
      ),
      por_grupo AS (
        SELECT ag.alumno_id
        FROM mensaje_destino md
        JOIN alumno_grupo ag ON ag.grupo_id = md.grupo_id
        WHERE md.mensaje_id = $1 AND md.grupo_id IS NOT NULL
      ),
      por_alumno AS (
        SELECT md.alumno_id FROM mensaje_destino md WHERE md.mensaje_id = $1 AND md.alumno_id IS NOT NULL
      )
      SELECT DISTINCT
        COALESCE(pg.alumno_id, pa.alumno_id, u.alumno_id) AS alumno_id
      FROM base b
      LEFT JOIN t_broadcast tb ON TRUE
      LEFT JOIN por_grupo pg ON TRUE
      LEFT JOIN por_alumno pa ON TRUE
      LEFT JOIN universo u ON tb.hay IS TRUE
      WHERE (pg.alumno_id IS NOT NULL) OR (pa.alumno_id IS NOT NULL) OR (tb.hay IS TRUE)
    `, [mensajeId]);

    const alumnoIds = destinatarios.rows.map(r => r.alumno_id);

    if (alumnoIds.length) {
      // Crear entregas
      const vals = alumnoIds.map((_, i) => `($1, $${i+2})`).join(',');
      await db.query(
        `INSERT INTO mensaje_entrega (mensaje_id, alumno_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [mensajeId, ...alumnoIds]
      );

      // Enviar push
      const subs = await db.query(`
        SELECT ps.endpoint, ps.p256dh, ps.auth
        FROM push_suscripciones ps
        WHERE ps.alumno_id = ANY($1::int[])
      `, [alumnoIds]);

      const payload = { tipo: 'mensaje', mensaje_id: mensajeId, titulo, cuerpo, url: url || null };
      for (const s of subs.rows) {
        const ret = await enviarPush({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth }
        }, payload);

        if (ret === 'expired') {
          await db.query('DELETE FROM push_suscripciones WHERE endpoint = $1', [s.endpoint]);
        }
      }
    }

    await db.query('COMMIT');
    res.json({ success: true, mensaje_id: mensajeId, enviados: alumnoIds.length });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('❌ Crear/enviar mensaje:', err);
    res.status(500).json({ error: 'Error creando o enviando el mensaje' });
  }
});

/**
 * API app móvil: suscripción push
 * body: { endpoint, keys: {p256dh, auth}, alumno_id }
 */
router.post('/push/subscribe', async (req, res) => {
  const { alumno_id, endpoint, keys } = req.body || {};
  if (!alumno_id || !endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  try {
    await db.query(
      `INSERT INTO push_suscripciones (alumno_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO NOTHING`,
      [alumno_id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Guardando suscripción', e);
    res.status(500).json({ error: 'No se pudo guardar la suscripción' });
  }
});

/**
 * API app móvil: inbox (paginado/simple)
 * GET /app/mensajes?desde_id=…
 */
router.get('/app/mensajes', async (req, res) => {
  const alumnoId = parseInt(req.query.alumno_id, 10);
  if (!alumnoId) return res.status(400).json({ error: 'alumno_id requerido' });

  const desdeId = parseInt(req.query.desde_id, 10) || 0;
  try {
    const { rows } = await db.query(`
      SELECT m.id, m.titulo, m.cuerpo, m.url, m.created_at, me.leido_at
      FROM mensaje_entrega me
      JOIN mensajes m ON m.id = me.mensaje_id
      WHERE me.alumno_id = $1 AND m.id > $2
      ORDER BY m.id DESC
      LIMIT 50
    `, [alumnoId, desdeId]);

    res.json(rows);
  } catch (e) {
    console.error('❌ Listando mensajes', e);
    res.status(500).json({ error: 'No se pudo obtener mensajes' });
  }
});

/** Marcar como leído */
router.post('/app/mensajes/:id/leer', async (req, res) => {
  const alumnoId = parseInt(req.body.alumno_id, 10);
  const id = parseInt(req.params.id, 10);
  if (!alumnoId || !id) return res.status(400).json({ error: 'Datos inválidos' });

  try {
    await db.query(`
      UPDATE mensaje_entrega SET leido_at = NOW()
      WHERE mensaje_id = $1 AND alumno_id = $2
    `, [id, alumnoId]);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Marcando leído', e);
    res.status(500).json({ error: 'No se pudo actualizar' });
  }
});

module.exports = router;
