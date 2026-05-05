// routes/cuotas.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { Parser } = require('json2csv');
const { toISODate } = require('../utils/fechas');

router.get('/', async (req, res) => {
  try {
    const { rows: cuotas } = await db.query(`
      SELECT cuotas.*, tipos_cuota.tipo AS tipo_nombre
      FROM cuotas
      LEFT JOIN tipos_cuota ON cuotas.tipo_id = tipos_cuota.id
    `);
    res.render('cuotas_menu', { cuotas, busqueda: '', hero: false });
  } catch (err) {
    console.error('Error al obtener cuotas:', err);
    res.status(500).send('Error al obtener cuotas');
  }
});

router.get('/mostrar', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, precio FROM cuotas ORDER BY nombre ASC'
    );
    res.render('cuotas_mostrar', { title: 'Cuotas', hero: false, cuotas: rows || [] });
  } catch (e) {
    console.error(e);
    res.render('cuotas_mostrar', { title: 'Cuotas', hero: false, cuotas: [] });
  }
});

router.get('/nueva', async (req, res) => {
  try {
    const { rows: tipos } = await db.query('SELECT * FROM tipos_cuota');
    res.render('cuotas_ficha', { cuota: null, tipos, hero: false });
  } catch (err) {
    console.error('Error al cargar tipos de cuota:', err);
    res.status(500).send('Error cargando formulario');
  }
});

router.get('/editar/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: cuotaRows } = await db.query(`SELECT * FROM cuotas WHERE id = $1`, [id]);
    const { rows: tipos } = await db.query(`SELECT * FROM tipos_cuota`);
    const cuota = cuotaRows[0];
    if (!cuota) return res.status(404).send('Cuota no encontrada');
    res.render('cuotas_ficha', { cuota, tipos, hero: false });
  } catch (err) {
    console.error('Error cargando formulario de edición:', err);
    res.status(500).send('Error cargando formulario');
  }
});

router.post('/', async (req, res) => {
  const { nombre, precio, descripcion, tipo_id } = req.body;
  try {
    await db.query(
      `INSERT INTO cuotas (nombre, precio, descripcion, tipo_id) VALUES ($1, $2, $3, $4)`,
      [nombre, precio, descripcion, tipo_id]
    );
    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al guardar cuota:', err);
    res.status(500).send('Error al guardar cuota');
  }
});

router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { nombre, tipo_id, precio, descripcion } = req.body;
  try {
    await db.query(
      `UPDATE cuotas SET nombre = $1, tipo_id = $2, precio = $3, descripcion = $4 WHERE id = $5`,
      [nombre, tipo_id, precio, descripcion, id]
    );
    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al actualizar cuota:', err);
    res.status(500).send('Error al actualizar cuota');
  }
});

router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query(`DELETE FROM cuotas WHERE id = $1`, [id]);
    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al eliminar cuota:', err);
    res.status(500).send('Error al eliminar cuota');
  }
});

router.get('/asignar', async (req, res) => {
  try {
    const [gruposResult, cuotasResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM cuotas ORDER BY nombre')
    ]);
    res.render('asignar_cuotas', { grupos: gruposResult.rows, cuotas: cuotasResult.rows });
  } catch (err) {
    console.error('Error al cargar formulario:', err);
    res.status(500).send('Error al cargar formulario');
  }
});

// ✅ OPTIMIZADO: de N×M queries individuales a 1 INSERT masivo con ON CONFLICT DO NOTHING
router.post('/asignar', async (req, res) => {
  const { grupo_ids, cuota_id, fecha_inicio, fecha_fin } = req.body;

  const gruposSeleccionados = Array.isArray(grupo_ids) ? grupo_ids : (grupo_ids ? [grupo_ids] : []);
  const fechaIniISO = toISODate(fecha_inicio);
  const fechaFinISO = toISODate(fecha_fin);

  if (!gruposSeleccionados.length || !cuota_id || !fechaIniISO || !fechaFinISO) {
    return res.status(400).send('Parámetros inválidos: grupo(s), cuota y fechas son obligatorios.');
  }

  const client = await db.connect();
  try {
    // 1) Alumnos activos de los grupos seleccionados
    const grupoParams = gruposSeleccionados.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: alumnos } = await client.query(
      `SELECT DISTINCT a.id AS alumno_id FROM alumnos a
       JOIN alumno_grupo ag ON a.id = ag.alumno_id
       WHERE ag.grupo_id IN (${grupoParams}) AND a.activo = true`,
      gruposSeleccionados
    );

    if (!alumnos.length) {
      return res.status(400).send('No hay alumnos activos en los grupos seleccionados.');
    }

    // 2) Tipo de cuota para saber la periodicidad
    const { rows: tipoRows } = await client.query(
      `SELECT tc.tipo FROM cuotas c
       JOIN tipos_cuota tc ON c.tipo_id = tc.id
       WHERE c.id = $1`,
      [cuota_id]
    );
    if (!tipoRows.length) throw new Error('Tipo de cuota no encontrado');
    const tipo = tipoRows[0].tipo;

    // 3) Generar todas las fechas de vencimiento en memoria
    const fechas = [];
    const fechaIni = new Date(fechaIniISO);
    const fechaFin = new Date(fechaFinISO);
    let fechaActual = new Date(fechaIni);

    while (fechaActual <= fechaFin) {
      fechas.push(fechaActual.toISOString().split('T')[0]);
      if (tipo === 'Mensual') {
        fechaActual.setMonth(fechaActual.getMonth() + 1);
      } else if (tipo === 'Semanal') {
        fechaActual.setDate(fechaActual.getDate() + 7);
      } else {
        // Puntual: solo una fecha
        break;
      }
    }

    if (!fechas.length) {
      return res.status(400).send('El rango de fechas no genera ningún vencimiento.');
    }

    // 4) Construir arrays para INSERT masivo con unnest
    const alumnoIds = [];
    const cuotaIds = [];
    const vencimientos = [];

    for (const { alumno_id } of alumnos) {
      for (const fecha of fechas) {
        alumnoIds.push(alumno_id);
        cuotaIds.push(cuota_id);
        vencimientos.push(fecha);
      }
    }

    // 5) Un solo INSERT masivo — ON CONFLICT DO NOTHING evita duplicados
    //    Requiere que exista una restricción UNIQUE(alumno_id, cuota_id, fecha_vencimiento)
    //    Si no existe, añádela: ALTER TABLE cuotas_alumno ADD CONSTRAINT cuotas_alumno_unique
    //    UNIQUE (alumno_id, cuota_id, fecha_vencimiento);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
       SELECT t.alumno_id, t.cuota_id, t.fecha_vencimiento, false
       FROM unnest($1::int[], $2::int[], $3::date[]) AS t(alumno_id, cuota_id, fecha_vencimiento)
       ON CONFLICT (alumno_id, cuota_id, fecha_vencimiento) DO NOTHING`,
      [alumnoIds, cuotaIds.map(Number), vencimientos]
    );
    await client.query('COMMIT');

    console.log(`[cuotas/asignar] ${alumnoIds.length} combinaciones procesadas (${alumnos.length} alumnos × ${fechas.length} fechas)`);
    res.redirect('/alumnos');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en asignación masiva:', err);
    res.status(500).send('Error durante la asignación');
  } finally {
    client.release();
  }
});

router.get('/pendientes', async (req, res) => {
  const buscar = req.query.buscar?.trim().toLowerCase() || '';

  const queryBase = `
    SELECT 
      a.id AS alumno_id,
      a.nombre || ' ' || a.apellidos AS alumno,
      c.nombre AS cuota,
      ca.fecha_vencimiento,
      ca.pagado,
      (CURRENT_DATE - ca.fecha_vencimiento::date) AS dias_retraso
    FROM cuotas_alumno ca
    JOIN alumnos a ON a.id = ca.alumno_id
    JOIN cuotas c ON c.id = ca.cuota_id
    WHERE ca.pagado = false AND ca.fecha_vencimiento::date < CURRENT_DATE
  `;

  const params = [];
  let whereExtra = '';
  if (buscar) {
    params.push(`%${buscar}%`);
    whereExtra = ` AND (LOWER(a.nombre) || ' ' || LOWER(a.apellidos)) LIKE $${params.length}`;
  }

  try {
    const result = await db.query(`${queryBase} ${whereExtra} ORDER BY ca.fecha_vencimiento`, params);
    res.render('cuotas_pendientes', { cuotasPendientes: result.rows, buscar, hero: false });
  } catch (err) {
    console.error('❌ Error obteniendo cuotas pendientes:', err);
    res.status(500).send('Error obteniendo cuotas pendientes');
  }
});

router.put('/:id', async (req, res) => {
  const id = req.params.id;
  const { nombre, tipo_id, precio, descripcion } = req.body;
  try {
    await db.query(
      'UPDATE cuotas SET nombre = $1, tipo_id = $2, precio = $3, descripcion = $4 WHERE id = $5',
      [nombre, tipo_id, precio, descripcion, id]
    );
    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al actualizar cuota:', err);
    res.status(500).send('Error al actualizar cuota');
  }
});

router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM cuotas WHERE id = $1', [id]);
    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al eliminar la cuota:', err.message);
    res.status(500).send('Error al eliminar la cuota.');
  }
});

router.post('/alumno/eliminar/:id', async (req, res) => {
  const cuotaAlumnoId = parseInt(req.params.id, 10);
  const alumnoId = parseInt(req.query.alumno_id, 10);
  const tab = req.query.tab || '';
  try {
    await db.query('DELETE FROM cuotas_alumno WHERE id = $1 AND pagado = false', [cuotaAlumnoId]);
    res.redirect(`/alumnos/${alumnoId}${tab ? `?tab=${tab}` : ''}`);
  } catch (err) {
    console.error('❌ Error al eliminar cuota de alumno:', err.message);
    res.status(500).send('Error al eliminar cuota');
  }
});

router.get('/api/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;
  const page = parseInt(req.query.page) || 1;
  const perPage = 5;
  const offset = (page - 1) * perPage;
  try {
    const result = await db.query(
      `SELECT ca.*, c.nombre AS nombre_cuota, c.precio
       FROM cuotas_alumno ca
       JOIN cuotas c ON ca.cuota_id = c.id
       WHERE ca.alumno_id = $1
       ORDER BY ca.fecha_vencimiento ASC
       LIMIT $2 OFFSET $3`,
      [alumnoId, perPage, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error paginando cuotas:', err.message);
    res.status(500).json({ error: 'Error al obtener cuotas' });
  }
});

router.get('/ayuda', (req, res) => {
  res.render('ayuda_cuotas', { title: 'Ayuda · Cuotas', hero: false });
});

module.exports = router;
