const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const path = require('path');

// Multer config
const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

router.get('/nuevo', (req, res) => {
  db.all('SELECT * FROM instrumentos', (err, instrumentos) => {
    if (err) return res.status(500).send('Error al cargar instrumentos');

    db.all('SELECT * FROM grupos', (err2, grupos) => {
      if (err2) return res.status(500).send('Error al cargar grupos');
      res.render('alumno_form', {
        alumno: null,
        instrumentos,
        instrumentosAlumno: [],
        grupos,
        gruposAlumno: [],
        hero: false
      });
    });
  });
});

router.post('/', upload.single('foto'), (req, res) => {
  const {
    nombre, apellidos, tutor, direccion, codigo_postal, municipio, provincia, telefono,
    email, fecha_nacimiento, DNI, centro, profesor_centro,
    instrumentos, grupos
  } = req.body;

  const activo = req.body.activo === '1' ? 1 : 0;
  const foto = req.file ? req.file.filename : null;
  const fecha_matriculacion = new Date().toISOString().split('T')[0]; // yyyy-mm-dd

  db.run(
    `INSERT INTO alumnos 
    (nombre, apellidos, tutor, direccion, codigo_postal, municipio, provincia, telefono, email, fecha_nacimiento, DNI, centro, profesor_centro, foto, activo, fecha_matriculacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nombre, apellidos, tutor, direccion, codigo_postal, municipio, provincia, telefono, email, fecha_nacimiento, DNI, centro, profesor_centro, foto, activo, fecha_matriculacion],
    function (err) {
      if (err) return res.status(500).send('Error al guardar alumno');

      const alumnoId = this.lastID;
      const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : [instrumentos];
      const stmt = db.prepare('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES (?, ?)');
      instrumentosArray.forEach(instId => {
        if (instId) stmt.run(alumnoId, instId);
      });

      const grupoIds = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
      const stmtGrupo = db.prepare('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES (?, ?)');
      grupoIds.forEach(grupoId => {
        if (grupoId) stmtGrupo.run(alumnoId, grupoId);
      });

      stmt.finalize(() => {
        stmtGrupo.finalize(() => res.redirect('/alumnos'));
      });
    }
  );
});

// PUT: Actualizar alumno
router.put('/:id', upload.single('foto'), (req, res) => {
  const id = req.params.id;
  const {
    nombre, apellidos, tutor, direccion, codigo_postal, municipio, provincia, telefono,
    email, fecha_nacimiento, DNI, centro, profesor_centro,
    instrumentos, grupos
  } = req.body;
  const activo = req.body.activo === '1' ? 1 : 0;
  const foto = req.file ? req.file.filename : null;
  const fechaBaja = activo === 0 ? new Date().toISOString().split('T')[0] : null;
  const query = foto
    ? `UPDATE alumnos SET nombre = ?, apellidos = ?, email = ?, telefono = ?, direccion = ?, codigo_postal = ?, municipio = ?, provincia = ?, tutor = ?, fecha_nacimiento = ?, DNI = ?, centro = ?, profesor_centro = ?, foto = ?, activo = ?, fecha_baja = ? WHERE id = ?`
    : `UPDATE alumnos SET nombre = ?, apellidos = ?, email = ?, telefono = ?, direccion = ?, codigo_postal = ?, municipio = ?, provincia = ?, tutor = ?, fecha_nacimiento = ?, DNI = ?, centro = ?, profesor_centro = ?, foto = ?, activo = ?, fecha_baja = ? WHERE id = ?`;

  const params = foto
    ? [nombre, apellidos, email, telefono, direccion, codigo_postal, municipio, provincia, tutor, fecha_nacimiento, DNI, centro, profesor_centro, foto, activo, fechaBaja, id]
    : [nombre, apellidos, email, telefono, direccion, codigo_postal, municipio, provincia, tutor, fecha_nacimiento, DNI, centro, profesor_centro, foto, activo, fechaBaja, id];

  db.run(query, params, err => {
    if (err) return res.status(500).send('Error al actualizar alumno');

    db.run('DELETE FROM alumno_instrumento WHERE alumno_id = ?', [id], err2 => {
      if (err2) return res.status(500).send('Error al limpiar instrumentos');

      const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : [instrumentos];
      const stmt = db.prepare('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES (?, ?)');
      instrumentosArray.forEach(instId => {
        if (instId) stmt.run(id, instId);
      });

      stmt.finalize(() => {
        db.run('DELETE FROM alumno_grupo WHERE alumno_id = ?', [id], () => {
          const grupoIds = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
          const stmtGrupo = db.prepare('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES (?, ?)');
          grupoIds.forEach(grupoId => {
            if (grupoId) stmtGrupo.run(id, grupoId);
          });
          stmtGrupo.finalize(() => res.redirect(`/alumnos/${id}`));
        });
      });
    });
  });
});

router.get('/:id/editar', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM alumnos WHERE id = ?', [id], (err, alumno) => {
    if (err || !alumno) return res.status(404).send('Alumno no encontrado');

    db.all('SELECT * FROM instrumentos', (err2, instrumentos) => {
      if (err2) return res.status(500).send('Error al cargar instrumentos');

      db.all('SELECT instrumento_id FROM alumno_instrumento WHERE alumno_id = ?', [id], (err3, filas) => {
        if (err3) return res.status(500).send('Error al obtener instrumentos');
        const instrumentosAlumno = filas.map(f => f.instrumento_id);

        db.all('SELECT * FROM grupos', (err4, grupos) => {
          if (err4) return res.status(500).send('Error al cargar grupos');

          db.all('SELECT grupo_id FROM alumno_grupo WHERE alumno_id = ?', [id], (err5, filasGrupos) => {
            if (err5) return res.status(500).send('Error al obtener grupos');
            const gruposAlumno = filasGrupos.map(f => f.grupo_id);
            res.render('alumno_form', {
              alumno,
              instrumentos,
              instrumentosAlumno,
              grupos,
              gruposAlumno,
              hero: false
            });
          });
        });
      });
    });
  });
});

router.get('/nuevo/:alumnoId', (req, res) => {
  const alumnoId = req.params.alumnoId;

  db.get('SELECT * FROM alumnos WHERE id = ?', [alumnoId], (err, alumno) => {
    if (err || !alumno) return res.status(404).send('Alumno no encontrado');
    res.render('alumnos_ficha', {
      alumno: {
        ...alumno,
        instrumentos: instrumentos.map(i => i.nombre).join(', '),
        grupos: grupos.map(g => g.nombre).join(', ')
      },
      pagos,
      cuotasDisponibles
    });
  });
});

router.post('/generar-cuotas', (req, res) => {
  const { alumno_id, cuota_id, fecha_inicio, fecha_fin } = req.body;

  const fechaIni = new Date(fecha_inicio);
  const fechaFin = new Date(fecha_fin);

  const cuotasInsertadas = [];

  const insertarCuotasRecursivo = (fechaActual) => {
    if (fechaActual > fechaFin) {
      return res.redirect('/alumnos/' + alumno_id);
    }

    const año = fechaActual.getFullYear();
    const mes = fechaActual.getMonth() + 1;
    const fechaVenc = `${año}-${mes.toString().padStart(2, '0')}-01`;

    // Verificar si ya existe una cuota para ese alumno, mes y tipo
    db.get(`
      SELECT 1 FROM cuotas_alumno
      WHERE alumno_id = ? AND cuota_id = ? AND fecha_vencimiento = ?
    `, [alumno_id, cuota_id, fechaVenc], (err, existente) => {
      if (err) return res.status(500).send('Error verificando cuotas');

      if (!existente) {
        db.run(`
          INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
          VALUES (?, ?, ?, 0)
        `, [alumno_id, cuota_id, fechaVenc], (err2) => {
          if (err2) return res.status(500).send('Error al generar cuota');
        });
      }

      // Siguiente mes
      fechaActual.setMonth(fechaActual.getMonth() + 1);
      insertarCuotasRecursivo(fechaActual);
    });
  };

  insertarCuotasRecursivo(new Date(fechaIni.getFullYear(), fechaIni.getMonth(), 1));
});

// GET: Lista de alumnos
router.get('/', (req, res) => {
  const estado = req.query.estado;
  const busqueda = req.query.busqueda || '';
  const grupoId = req.query.grupo_id;

  let sql = `
    SELECT a.*, 
           GROUP_CONCAT(DISTINCT i.nombre) AS instrumentos
    FROM alumnos a
    LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
    LEFT JOIN instrumentos i ON ai.instrumento_id = i.id
    LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
  `;

  const params = [];
  const condiciones = [];

  if (estado === '0' || estado === '1') {
    condiciones.push('a.activo = ?');
    params.push(parseInt(estado));
  }

  if (busqueda.trim()) {
    condiciones.push('(a.nombre LIKE ? OR a.apellidos LIKE ?)');
    params.push(`%${busqueda}%`, `%${busqueda}%`);
  }

  if (grupoId && grupoId !== 'todos') {
    condiciones.push('ag.grupo_id = ?');
    params.push(grupoId);
  }

  if (condiciones.length > 0) {
    sql += ' WHERE ' + condiciones.join(' AND ');
  }

  sql += ' GROUP BY a.id';

  db.all('SELECT * FROM grupos ORDER BY nombre', (err2, grupos) => {
    if (err2) grupos = [];

    db.all(sql, params, (err, alumnos) => {
      if (err) return res.status(500).send('Error al obtener alumnos');

      alumnos.sort((a, b) => {
        const nombreA = (a.apellidos + a.nombre).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const nombreB = (b.apellidos + b.nombre).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        return nombreA.localeCompare(nombreB);
      });

      res.render('alumnos_lista', {
        alumnos,
        query: estado || 'todos',
        busqueda,
        grupoId,
        grupos,
        estadoSeleccionado: estado || 'todos',
        grupoSeleccionado: grupoId || 'todos',
        hero: false
      });
    });
  });
});
// GET: Ficha alumno
router.get('/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM alumnos WHERE id = ?', [id], (err, alumno) => {
    if (err || !alumno) return res.status(404).send('Alumno no encontrado');

    const pagosQuery = `
      SELECT 
        p.id AS pago_id,
        p.fecha_pago,
        p.importe AS importe_pago,
        p.medio_pago,
        p.referencia,
        p.observaciones,
        c.nombre AS cuota_nombre,
        pca.importe_aplicado
      FROM pagos p
      JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
      JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
      JOIN cuotas c ON ca.cuota_id = c.id
      WHERE p.alumno_id = ?
      ORDER BY p.fecha_pago DESC
    `;

    db.all(pagosQuery, [id], (errPagos, pagos = []) => {
      db.all('SELECT i.nombre FROM instrumentos i JOIN alumno_instrumento ai ON i.id = ai.instrumento_id WHERE ai.alumno_id = ?', [id], (err2, instrumentos = []) => {
        db.all('SELECT g.nombre FROM grupos g JOIN alumno_grupo ag ON g.id = ag.grupo_id WHERE ag.alumno_id = ?', [id], (err3, grupos = []) => {
          db.all('SELECT * FROM cuotas ORDER BY nombre', (err4, cuotasDisponibles = []) => {
            db.all(`
              SELECT ca.*, c.nombre AS nombre_cuota, c.precio
              FROM cuotas_alumno ca
              JOIN cuotas c ON ca.cuota_id = c.id
              WHERE ca.alumno_id = ?
              ORDER BY ca.fecha_vencimiento ASC
            `, [id], (err5, cuotasAlumno = []) => {

              // Calcular resumen financiero
              db.get(`
                SELECT
                  COALESCE(SUM(c.precio), 0) AS total_cuotas,
                  COALESCE((
                    SELECT SUM(pca.importe_aplicado)
                    FROM cuotas_alumno ca2
                    JOIN pago_cuota_alumno pca ON pca.cuota_alumno_id = ca2.id
                    WHERE ca2.alumno_id = ?
                  ), 0) AS total_pagado
                FROM cuotas_alumno ca
                JOIN cuotas c ON ca.cuota_id = c.id
                WHERE ca.alumno_id = ?
              `, [id, id], (err6, resumen = { total_cuotas: 0, total_pagado: 0 }) => {
                resumen.total_pendiente = resumen.total_cuotas - resumen.total_pagado;

                res.render('alumnos_ficha', {
                  alumno: {
                    ...alumno,
                    instrumentos: instrumentos.map(i => i.nombre).join(', '),
                    grupos: grupos.map(g => g.nombre).join(', ')
                  },
                  pagos,
                  cuotasDisponibles,
                  cuotasAlumno,
                  resumenDeuda: resumen
                });
              });
            });
          });
        });
      });
    });
  });
});

module.exports = router;