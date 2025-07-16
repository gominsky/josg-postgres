const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Listado de cuotas con tipo
router.get('/', (req, res) => {
  const busqueda = req.query.busqueda || '';

  const sql = `
    SELECT cuotas.*, tipos_cuota.tipo AS tipo_nombre
    FROM cuotas
    LEFT JOIN tipos_cuota ON cuotas.tipo_id = tipos_cuota.id
  `;

  db.all(sql, (err, cuotas) => {
    if (err) return res.status(500).send('Error al obtener cuotas');
    res.render('cuotas_lista', { cuotas, busqueda, hero: false });
  });
});

// GET: Formulario nueva cuota
router.get('/nueva', (req, res) => {
  const tiposQuery = `SELECT * FROM tipos_cuota`;

  db.all(tiposQuery, (err, tipos) => {
    if (err) {
      console.error('Error al obtener tipos de cuota:', err.message);
      return res.status(500).send('Error cargando formulario');
    }

    res.render('cuotas_ficha', {
      cuota: null,
      tipos, // [{ id, tipo }]
      hero: false
    });
  });
});

// GET: Formulario edición
router.get('/editar/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM cuotas WHERE id = ?', [id], (err, cuota) => {
    if (err || !cuota) return res.status(404).send('Cuota no encontrada');

    db.all('SELECT * FROM tipos_cuota', (err2, tipos) => {
      if (err2) {
        console.error('Error al obtener tipos de cuota:', err2.message);
        return res.status(500).send('Error cargando formulario');
      }
      res.render('cuotas_ficha', {
        cuota,
        tipos,
        hero: false
      });
    });
  });
});

// POST: Crear cuota
router.post('/', (req, res) => {
  const { nombre, precio, descripcion, tipo_id } = req.body;

  db.run(
    'INSERT INTO cuotas (nombre, precio, descripcion, tipo_id) VALUES (?, ?, ?, ?)',
    [nombre, precio, descripcion, tipo_id],
    err => {
      if (err) return res.status(500).send('Error al guardar cuota');
      res.redirect('/cuotas');
    }
  );
});
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const { nombre, tipo_id, precio, descripcion } = req.body;

  db.run(
    'UPDATE cuotas SET nombre = ?, tipo_id = ?, precio = ?, descripcion = ? WHERE id = ?',
    [nombre, tipo_id, precio, descripcion, id],
    err => {
      if (err) return res.status(500).send('Error al actualizar cuota');
      res.redirect('/cuotas');
    }
  );
});

// POST: Actualizar cuota
router.post('/editar/:id', (req, res) => {
  const id = req.params.id;
  const { nombre, tipo_id, precio, descripcion } = req.body;

  db.run(
    'UPDATE cuotas SET nombre = ?, tipo_id = ?, precio = ?, descripcion = ? WHERE id = ?',
    [nombre, tipo_id, precio, descripcion, id],
    err => {
      if (err) return res.status(500).send('Error al actualizar cuota');
      res.redirect('/cuotas');
    }
  );
});

// POST: Eliminar cuota
router.post('/eliminar/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM cuotas WHERE id = ?', [id], err => {
    if (err) return res.status(500).send('Error al eliminar cuota');
    res.redirect('/cuotas');
  });
});
router.delete('/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM cuotas WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Error al eliminar la cuota:', err.message);
      return res.status(500).send('Error al eliminar la cuota.');
    }

    res.redirect('/cuotas');
  });
});
// GET: Formulario de asignación masiva
router.get('/asignar', (req, res) => {
  db.all('SELECT * FROM grupos ORDER BY nombre', (err1, grupos) => {
    if (err1) return res.status(500).send('Error al cargar grupos');

    db.all('SELECT * FROM cuotas ORDER BY nombre', (err2, cuotas) => {
      if (err2) return res.status(500).send('Error al cargar cuotas');

      res.render('asignar_cuotas', {
        grupos,
        cuotas
      });
    });
  });
});

// POST: Procesar asignación masiva
router.post('/asignar', (req, res) => {
  const { grupo_ids, cuota_id, fecha_inicio, fecha_fin } = req.body;
  const gruposSeleccionados = Array.isArray(grupo_ids) ? grupo_ids : [grupo_ids];

  const fechaIni = new Date(fecha_inicio);
  const fechaFin = new Date(fecha_fin);

  const placeholders = gruposSeleccionados.map(() => '?').join(',');

  db.all(
    `SELECT DISTINCT a.id as alumno_id
    FROM alumnos a
    JOIN alumno_grupo ag ON a.id = ag.alumno_id
    WHERE ag.grupo_id IN (${placeholders})
    AND a.activo = 1`,
    gruposSeleccionados,
    (err, alumnos) => {
      if (err) return res.status(500).send('Error al buscar alumnos');

      const insertarCuotasAlumno = (alumnoId, fechaActual, done) => {
        if (fechaActual > fechaFin) return done();

        const año = fechaActual.getFullYear();
        const mes = fechaActual.getMonth() + 1;
        const fechaVenc = `${año}-${mes.toString().padStart(2, '0')}-01`;

        db.get(`
          SELECT 1 FROM cuotas_alumno
          WHERE alumno_id = ? AND cuota_id = ? AND fecha_vencimiento = ?
        `, [alumnoId, cuota_id, fechaVenc], (err2, existente) => {
          if (err2) return done(err2);

          const siguienteMes = () => {
            fechaActual.setMonth(fechaActual.getMonth() + 1);
            insertarCuotasAlumno(alumnoId, fechaActual, done);
          };

          if (!existente) {
            db.run(`
              INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
              VALUES (?, ?, ?, 0)
            `, [alumnoId, cuota_id, fechaVenc], (err3) => {
              if (err3) return done(err3);
              siguienteMes();
            });
          } else {
            siguienteMes();
          }
        });
      };

      let procesados = 0;
      let errores = 0;

      if (alumnos.length === 0) return res.redirect('/cuotas/asignar');

      alumnos.forEach(({ alumno_id }) => {
        insertarCuotasAlumno(alumno_id, new Date(fechaIni.getFullYear(), fechaIni.getMonth(), 1), (err) => {
          if (err) errores++;
          procesados++;
          if (procesados === alumnos.length) {
            if (errores > 0) {
              res.status(500).send(`Se produjeron ${errores} errores durante la asignación.`);
            } else {
              res.redirect('/alumnos');
            }
          }
        });
      });
    }
  );
});

// GET: Cuotas pendientes
router.get('/pendientes', (req, res) => {
  const hoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const query = `
    SELECT 
      a.nombre || ' ' || a.apellidos AS alumno,
      c.nombre AS cuota,
      ca.fecha_vencimiento,
      ca.pagado,
      JULIANDAY(?) - JULIANDAY(ca.fecha_vencimiento) AS dias_retraso
    FROM cuotas_alumno ca
    JOIN alumnos a ON a.id = ca.alumno_id
    JOIN cuotas c ON c.id = ca.cuota_id
    WHERE ca.pagado = 0 AND DATE(ca.fecha_vencimiento) < DATE(?)
    ORDER BY ca.fecha_vencimiento ASC
  `;

  db.all(query, [hoy, hoy], (err, cuotasPendientes = []) => {
    if (err) return res.status(500).send('Error obteniendo cuotas pendientes');

    res.render('cuotas_pendientes', {
      cuotasPendientes,
      hoy,
      hero: false
    });
  });
});
const { Parser } = require('json2csv');

router.get('/pendientes/export', (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];

  const query = `
    SELECT 
      a.nombre || ' ' || a.apellidos AS alumno,
      c.nombre AS cuota,
      ca.fecha_vencimiento,
      JULIANDAY(?) - JULIANDAY(ca.fecha_vencimiento) AS dias_retraso,
      'Pendiente' AS estado
    FROM cuotas_alumno ca
    JOIN alumnos a ON a.id = ca.alumno_id
    JOIN cuotas c ON c.id = ca.cuota_id
    WHERE ca.pagado = 0 AND DATE(ca.fecha_vencimiento) < DATE(?)
  `;

  db.all(query, [hoy, hoy], (err, data = []) => {
    if (err) return res.status(500).send('Error exportando datos');

    const fields = ['alumno', 'cuota', 'fecha_vencimiento', 'dias_retraso', 'estado'];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    res.header('Content-Type', 'text/csv');
    res.attachment(`cuotas_pendientes_${hoy}.csv`);
    return res.send(csv);
  });
});

module.exports = router;


