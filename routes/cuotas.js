// rutas/cuotas.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { Parser } = require('json2csv');

router.get('/', async (req, res) => {
  try {
    const { rows: cuotas } = await db.query(`
      SELECT cuotas.*, tipos_cuota.tipo AS tipo_nombre
      FROM cuotas
      LEFT JOIN tipos_cuota ON cuotas.tipo_id = tipos_cuota.id
    `);

    res.render('cuotas_lista', { cuotas, busqueda: '', hero: false });
  } catch (err) {
    console.error('Error al obtener cuotas:', err);
    res.status(500).send('Error al obtener cuotas');
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
  const id = parseInt(req.params.id, 10); // aseguramos tipo número
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
    const query = `
      INSERT INTO cuotas (nombre, precio, descripcion, tipo_id)
      VALUES ($1, $2, $3, $4)
    `;
    const params = [nombre, precio, descripcion, tipo_id];

    await db.query(query, params);

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
    const query = `
      UPDATE cuotas
      SET nombre = $1, tipo_id = $2, precio = $3, descripcion = $4
      WHERE id = $5
    `;
    const params = [nombre, tipo_id, precio, descripcion, id];

    await db.query(query, params);

    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al actualizar cuota:', err);
    res.status(500).send('Error al actualizar cuota');
  }
});
router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const query = `DELETE FROM cuotas WHERE id = $1`;
    await db.query(query, [id]);

    res.redirect('/cuotas');
  } catch (err) {
    console.error('Error al eliminar cuota:', err);
    res.status(500).send('Error al eliminar cuota');
  }
});
router.get('/asignar', async (req, res) => {
  try {
    const gruposQuery = 'SELECT * FROM grupos ORDER BY nombre';
    const cuotasQuery = 'SELECT * FROM cuotas ORDER BY nombre';

    const [gruposResult, cuotasResult] = await Promise.all([
      db.query(gruposQuery),
      db.query(cuotasQuery)
    ]);

    const grupos = gruposResult.rows;
    const cuotas = cuotasResult.rows;

    res.render('asignar_cuotas', { grupos, cuotas });
  } catch (err) {
    console.error('Error al cargar formulario:', err);
    res.status(500).send('Error al cargar formulario');
  }
});
router.post('/asignar', async (req, res) => {
  const { grupo_ids, cuota_id, fecha_inicio, fecha_fin } = req.body;
  const gruposSeleccionados = Array.isArray(grupo_ids) ? grupo_ids : [grupo_ids];
  try {
    const grupoParams = gruposSeleccionados.map((_, i) => `$${i + 1}`).join(', ');
    const alumnosSQL = `
      SELECT DISTINCT a.id as alumno_id FROM alumnos a
      JOIN alumno_grupo ag ON a.id = ag.alumno_id
      WHERE ag.grupo_id IN (${grupoParams}) AND a.activo = true
    `;
    const alumnosRes = await db.query(alumnosSQL, gruposSeleccionados);
    const alumnos = alumnosRes.rows;

    const fechaIni = new Date(fecha_inicio);
    const fechaFin = new Date(fecha_fin);

    const tipoRes = await db.query(`
      SELECT tc.tipo FROM cuotas c
      JOIN tipos_cuota tc ON c.tipo_id = tc.id
      WHERE c.id = $1
    `, [cuota_id]);
    
    if (tipoRes.rows.length === 0) throw new Error('Tipo de cuota no encontrado');
    const tipo = tipoRes.rows[0].tipo;
    
    for (const { alumno_id } of alumnos) {
      let fechaActual = new Date(fechaIni);
      while (fechaActual <= fechaFin) {
        const venc = fechaActual.toISOString().split('T')[0];
    
        const checkSQL = `
          SELECT 1 FROM cuotas_alumno 
          WHERE alumno_id = $1 AND cuota_id = $2 AND fecha_vencimiento = $3
        `;
        const existente = await db.query(checkSQL, [alumno_id, cuota_id, venc]);
    
        if (existente.rowCount === 0) {
          const insertSQL = `
            INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
            VALUES ($1, $2, $3, false)
          `;
          await db.query(insertSQL, [alumno_id, cuota_id, venc]);
        }
    
        if (tipo === 'Mensual') {
          fechaActual.setMonth(fechaActual.getMonth() + 1);
        } else if (tipo === 'Semanal') {
          fechaActual.setDate(fechaActual.getDate() + 7);
        } else if (tipo === 'Puntual') {
          break;
        }
      }
    }    
    res.redirect('/alumnos');
  } catch (err) {
    console.error('Error en asignación masiva:', err);
    res.status(500).send('Error durante la asignación');
  }
});
router.get('/pendientes', async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const query = `
  SELECT 
    a.nombre || ' ' || a.apellidos AS alumno,
    c.nombre AS cuota,
    ca.fecha_vencimiento,
    ca.pagado,
    (CURRENT_DATE - ca.fecha_vencimiento::date) AS dias_retraso
    FROM cuotas_alumno ca
    JOIN alumnos a ON a.id = ca.alumno_id
    JOIN cuotas c ON c.id = ca.cuota_id
    WHERE ca.pagado = false AND ca.fecha_vencimiento::date < CURRENT_DATE
    ORDER BY ca.fecha_vencimiento::date ASC
  `;
  try {
    const result = await db.query(query);
    const cuotasPendientes = result.rows;

    res.render('cuotas_pendientes', {
      cuotasPendientes,
      hoy,
      hero: false
    });
  } catch (err) {
    console.error('❌ Error obteniendo cuotas pendientes:', err);
    res.status(500).send('Error obteniendo cuotas pendientes');
  }
});
router.get('/pendientes/export', async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];

  const query = `
    SELECT 
      a.nombre || ' ' || a.apellidos AS alumno,
      c.nombre AS cuota,
      ca.fecha_vencimiento,
      DATE_PART('day', $1::date - ca.fecha_vencimiento) AS dias_retraso,
      'Pendiente' AS estado
    FROM cuotas_alumno ca
    JOIN alumnos a ON a.id = ca.alumno_id
    JOIN cuotas c ON c.id = ca.cuota_id
    WHERE ca.pagado = false AND ca.fecha_vencimiento < $1::date
  `;

  try {
    const result = await db.query(query, [hoy]);

    const parser = new Parser({
      fields: ['alumno', 'cuota', 'fecha_vencimiento', 'dias_retraso', 'estado']
    });

    const csv = parser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.attachment(`cuotas_pendientes_${hoy}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exportando datos:', err);
    res.status(500).send('Error exportando datos');
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
  const tab = req.query.tab || ''; // ← leer tab opcional

  try {
    await db.query('DELETE FROM cuotas_alumno WHERE id = $1 AND pagado = false', [cuotaAlumnoId]);
    const redirectUrl = `/alumnos/${alumnoId}${tab ? `?tab=${tab}` : ''}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('❌ Error al eliminar cuota de alumno:', err.message);
    res.status(500).send('Error al eliminar cuota');
  }
});


module.exports = router;