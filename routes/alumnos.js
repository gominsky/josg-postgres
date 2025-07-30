const express = require('express');
const router = express.Router();
const db = require('../database/db');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

router.get('/nuevo', async (req, res) => {
  try {
    const instrumentos = (await db.query('SELECT * FROM instrumentos')).rows;
    const grupos = (await db.query('SELECT * FROM grupos')).rows;

    res.render('alumno_form', {
      alumno: null,
      instrumentos,
      instrumentosAlumno: [],
      grupos,
      gruposAlumno: [],
      hero: false
    });
  } catch (err) {
    res.status(500).send('Error al cargar instrumentos o grupos');
  }
});
router.post('/', upload.single('foto'), async (req, res) => {
  const {
    nombre, apellidos, tutor, direccion, codigo_postal,
    municipio, provincia, telefono, email,
    fecha_nacimiento, DNI, centro, profesor_centro,
    instrumentos, grupos
  } = req.body;

  const foto = req.file ? req.file.filename : null;
  const activo = req.body.activo === '1' ? true : false;
  const fechaMat = new Date().toISOString().split('T')[0];

  const sqlInsert = `
    INSERT INTO alumnos (
      nombre, apellidos, tutor, direccion, codigo_postal,
      municipio, provincia, telefono, email, fecha_nacimiento,
      DNI, centro, profesor_centro, foto, activo, fecha_matriculacion
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id
  `;
  const paramsInsert = [
    nombre, apellidos, tutor, direccion, codigo_postal,
    municipio, provincia, telefono, email,
    fecha_nacimiento, DNI, centro, profesor_centro,
    foto, activo, fechaMat
  ];

  try {
    const result = await db.query(sqlInsert, paramsInsert);
    const newId = result.rows[0].id;

    const instArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    for (let iid of instArray) {
      await db.query('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES ($1, $2)', [newId, iid]);
    }

    const grpArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
    for (let gid of grpArray) {
      await db.query('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES ($1, $2)', [newId, gid]);
    }

    res.redirect(`/alumnos/${newId}`);
  } catch (err) {
    console.error('Error al crear alumno:', err);
    res.status(500).send('Error al guardar alumno');
  }
});
// PUT: Actualizar alumno con preservación de foto y manejo de relaciones
router.put('/:id', upload.single('foto'), async (req, res) => {
  const id = req.params.id;
  const {
    nombre,
    apellidos,
    tutor,
    direccion,
    codigo_postal,
    municipio,
    provincia,
    telefono,
    email,
    fecha_nacimiento,
    DNI,
    centro,
    profesor_centro,
    instrumentos,
    grupos,
    fotoActual
  } = req.body;

  const foto = req.file ? req.file.filename : (fotoActual || null);
  const activo = req.body.activo === '1' ? 1 : 0;
  const fechaBaja = activo === 0 ? new Date().toISOString().split('T')[0] : null;

  const consulta = `
    UPDATE alumnos
    SET
      nombre = $1,
      apellidos = $2,
      tutor = $3,
      direccion = $4,
      codigo_postal = $5,
      municipio = $6,
      provincia = $7,
      telefono = $8,
      email = $9,
      fecha_nacimiento = $10,
      DNI = $11,
      centro = $12,
      profesor_centro = $13,
      foto = $14,
      activo = $15,
      fecha_baja = $16
    WHERE id = $17
  `;

  const params = [
    nombre,
    apellidos,
    tutor,
    direccion,
    codigo_postal,
    municipio,
    provincia,
    telefono,
    email,
    fecha_nacimiento,
    DNI,
    centro,
    profesor_centro,
    foto,
    activo,
    fechaBaja,
    id
  ];

  try {
    await db.query(consulta, params);

    await db.query('DELETE FROM alumno_instrumento WHERE alumno_id = $1', [id]);
    const arrInst = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    for (const iid of arrInst) {
      await db.query('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES ($1, $2)', [id, iid]);
    }

    await db.query('DELETE FROM alumno_grupo WHERE alumno_id = $1', [id]);
    const arrGrp = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
    for (const gid of arrGrp) {
      await db.query('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES ($1, $2)', [id, gid]);
    }

    res.redirect(`/alumnos/${id}`);
  } catch (err) {
    console.error('Error al actualizar alumno:', err);
    res.status(500).send('Error al actualizar alumno');
  }
});
router.get('/:id/editar', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const alumnoQuery = 'SELECT * FROM alumnos WHERE id = $1';
    const instrumentosQuery = 'SELECT * FROM instrumentos';
    const gruposQuery = 'SELECT * FROM grupos';
    const instrumentosAlumnoQuery = `
      SELECT instrumento_id FROM alumno_instrumento WHERE alumno_id = $1
    `;
    const gruposAlumnoQuery = `
      SELECT grupo_id FROM alumno_grupo WHERE alumno_id = $1
    `;

    const [alumnoResult, instrumentosResult, gruposResult, instAlumnoResult, grpAlumnoResult] =
      await Promise.all([
        db.query(alumnoQuery, [id]),
        db.query(instrumentosQuery),
        db.query(gruposQuery),
        db.query(instrumentosAlumnoQuery, [id]),
        db.query(gruposAlumnoQuery, [id])
      ]);

    const alumno = alumnoResult.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const instrumentosAlumno = instAlumnoResult.rows.map(r => r.instrumento_id);
    const gruposAlumno = grpAlumnoResult.rows.map(r => r.grupo_id);

    res.render('alumno_form', {
      alumno,
      instrumentos: instrumentosResult.rows,
      instrumentosAlumno,
      grupos: gruposResult.rows,
      gruposAlumno,
      hero: false
    });
  } catch (err) {
    console.error('Error cargando datos del alumno:', err);
    res.status(500).send('Error al cargar el formulario de edición');
  }
});
router.get('/', async (req, res) => {
  const estado = req.query.estado;
  const busqueda = req.query.busqueda || '';
  const grupoId = req.query.grupo_id;
  const params = [];
  const condiciones = [];

  let sql = `
    SELECT a.*,
           STRING_AGG(DISTINCT i.nombre, ', ') AS instrumentos
    FROM alumnos a
    LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
    LEFT JOIN instrumentos i ON ai.instrumento_id = i.id
    LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
  `;

  if (estado === '0' || estado === '1') {
    condiciones.push(`a.activo = $${params.length + 1}`);
    params.push(parseInt(estado));
  }

  if (busqueda.trim()) {
    condiciones.push(`(a.nombre ILIKE $${params.length + 1} OR a.apellidos ILIKE $${params.length + 2})`);
    params.push(`%${busqueda}%`, `%${busqueda}%`);
  }

  if (grupoId && grupoId !== 'todos') {
    condiciones.push(`ag.grupo_id = $${params.length + 1}`);
    params.push(grupoId);
  }

  if (condiciones.length > 0) {
    sql += ' WHERE ' + condiciones.join(' AND ');
  }

  sql += ' GROUP BY a.id';

  try {
    const [gruposResult, alumnosResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query(sql, params)
    ]);

    const alumnos = alumnosResult.rows.sort((a, b) => {
      const nombreA = (a.apellidos + a.nombre).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const nombreB = (b.apellidos + b.nombre).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return nombreA.localeCompare(nombreB);
    });

    res.render('alumnos_lista', {
      alumnos,
      query: estado || 'todos',
      busqueda,
      grupoId,
      grupos: gruposResult.rows,
      estadoSeleccionado: estado || 'todos',
      grupoSeleccionado: grupoId || 'todos',
      hero: false
    });
  } catch (err) {
    console.error('Error obteniendo alumnos:', err);
    res.status(500).send('Error al obtener alumnos');
  }
});
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).send('ID inválido');

  try {
    const alumnoResult = await db.query('SELECT * FROM alumnos WHERE id = $1', [id]);
    const alumno = alumnoResult.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const [
      pagosResult,
      instrumentosResult,
      gruposResult,
      cuotasDisponiblesResult,
      cuotasAlumnoResult,
      resumenResult
    ] = await Promise.all([
      db.query(`
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
        WHERE p.alumno_id = $1
        ORDER BY p.fecha_pago DESC
      `, [id]),
      db.query(`
        SELECT i.nombre
        FROM instrumentos i
        JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = $1
      `, [id]),
      db.query(`
        SELECT g.nombre
        FROM grupos g
        JOIN alumno_grupo ag ON g.id = ag.grupo_id
        WHERE ag.alumno_id = $1
      `, [id]),
      db.query('SELECT * FROM cuotas ORDER BY nombre'),
      db.query(`
        SELECT ca.*, c.nombre AS nombre_cuota, c.precio
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
        ORDER BY ca.fecha_vencimiento ASC
      `, [id]),
      db.query(`
        SELECT
          COALESCE(SUM(c.precio), 0) AS total_cuotas,
          COALESCE((
            SELECT SUM(pca.importe_aplicado)
            FROM cuotas_alumno ca2
            JOIN pago_cuota_alumno pca ON pca.cuota_alumno_id = ca2.id
            WHERE ca2.alumno_id = $1
          ), 0) AS total_pagado
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
      `, [id])
    ]);

    const instrumentos = instrumentosResult.rows.map(i => i.nombre).join(', ');
    const grupos = gruposResult.rows.map(g => g.nombre).join(', ');
    const resumen = resumenResult.rows[0] || { total_cuotas: 0, total_pagado: 0 };
    resumen.total_cuotas = Number(resumen.total_cuotas || 0);
    resumen.total_pagado = Number(resumen.total_pagado || 0);
    resumen.total_pendiente = resumen.total_cuotas - resumen.total_pagado;
    resumen.total_pendiente = resumen.total_cuotas - resumen.total_pagado;

    res.render('alumnos_ficha', {
      alumno: { ...alumno, instrumentos, grupos },
      pagos: pagosResult.rows,
      cuotasDisponibles: cuotasDisponiblesResult.rows,
      cuotasAlumno: cuotasAlumnoResult.rows,
      resumenDeuda: resumen
    });

  } catch (err) {
    console.error('Error mostrando detalle del alumno:', err);
    res.status(500).send('Error interno');
  }
});

module.exports = router;
