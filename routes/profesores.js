const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
// Configuración de multer
const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });
router.get('/:id/editar', async (req, res) => {
  const id = req.params.id;
  try {
    const profesorQuery = await db.query('SELECT * FROM profesores WHERE id = $1', [id]);
    const profesor = profesorQuery.rows[0];
    if (!profesor) return res.status(404).send('Profesor no encontrado');

    const instrumentosAll = (await db.query('SELECT * FROM instrumentos')).rows;
    const gruposAll = (await db.query('SELECT * FROM grupos')).rows;

    const instrumentosProf = await db.query(
      `SELECT instrumento_id FROM profesor_instrumento WHERE profesor_id = $1`,
      [id]
    );
    const gruposProf = await db.query(
      `SELECT grupo_id FROM profesor_grupo WHERE profesor_id = $1`,
      [id]
    );

    res.render('profesor_form', {
      profesor,
      instrumentos: instrumentosAll,
      instrumentosProfesor: instrumentosProf.rows.map(r => r.instrumento_id),
      grupos: gruposAll,
      gruposProfesor: gruposProf.rows.map(r => r.grupo_id),
      hero: false
    });
  } catch (err) {
    console.error('Error cargando profesor:', err);
    res.status(500).send('Error al obtener docente');
  }
});
// GET: Listado de profesores
router.get('/', async (req, res) => {
  const estado = req.query.estado;
  let query = 'SELECT * FROM profesores';
  const params = [];

  if (estado === '0' || estado === '1') {
    query += ' WHERE activo = $1';
    params.push(estado === '1');
  }

  query += ' ORDER BY apellidos, nombre';

  try {
    const result = await db.query(query, params);
    res.render('profesores_lista', {
      profesores: result.rows,
      estado 
    });
  } catch (err) {
    console.error('Error al listar profesores:', err);
    res.status(500).send('Error al obtener profesores');
  }
});

// GET: Nuevo profesor
router.get('/nuevo', async (req, res) => {
  try {
    const instrumentos = (await db.query('SELECT * FROM instrumentos')).rows;
    const grupos = (await db.query('SELECT * FROM grupos')).rows;

    res.render('profesor_form', {
      profesor: null,
      instrumentos,
      instrumentosProfesor: [],
      grupos,
      gruposProfesor: [],
      hero: false
    });
  } catch (err) {
    res.status(500).send('Error al cargar instrumentos o grupos');
  }
});
// POST: Crear profesor
router.post('/', upload.single('foto'), async (req, res) => {
  const {
    nombre, apellidos, email, telefono,
    direccion, fecha_nacimiento, especialidad,
    instrumentos, grupos
  } = req.body;
  const activo = req.body.activo === '1';
  const foto = req.file ? req.file.filename : null;

  const query = `
    INSERT INTO profesores (nombre, apellidos, email, telefono, direccion, fecha_nacimiento, especialidad, foto, activo)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `;
  const params = [nombre, apellidos, email, telefono, direccion, fecha_nacimiento, especialidad, foto, activo];

  try {
    const result = await db.query(query, params);
    const profesorId = result.rows[0].id;

    const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    const gruposArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];

    for (const instId of instrumentosArray) {
      await db.query('INSERT INTO profesor_instrumento (profesor_id, instrumento_id) VALUES ($1, $2)', [profesorId, instId]);
    }

    for (const grupoId of gruposArray) {
      await db.query('INSERT INTO profesor_grupo (profesor_id, grupo_id) VALUES ($1, $2)', [profesorId, grupoId]);
    }

    res.redirect('/profesores');
  } catch (err) {
    if (err.code === '23505') {
      return renderFormularioConError('El correo electrónico ya está registrado.');
    }
    res.status(500).send('Error al registrar el profesor');
  }

  async function renderFormularioConError(mensaje) {
    try {
      const gruposAll = (await db.query('SELECT * FROM grupos')).rows;
      const instrumentosAll = (await db.query('SELECT * FROM instrumentos')).rows;

      res.render('profesor_form', {
        error: mensaje,
        profesor: {
          nombre, apellidos, email, telefono,
          direccion, fecha_nacimiento, especialidad,
          activo
        },
        grupos: gruposAll,
        instrumentos: instrumentosAll,
        gruposProfesor: Array.isArray(grupos) ? grupos.map(Number) : grupos ? [Number(grupos)] : [],
        instrumentosProfesor: Array.isArray(instrumentos) ? instrumentos.map(Number) : instrumentos ? [Number(instrumentos)] : []
      });
    } catch (err) {
      res.status(500).send('Error al cargar formulario con error');
    }
  }
});

// GET: Ficha
router.get('/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const profesorRes = await db.query('SELECT * FROM profesores WHERE id = $1', [id]);
    const profesor = profesorRes.rows[0];
    if (!profesor) return res.status(404).send('Docente no encontrado');

    const instrumentosRes = await db.query(`
      SELECT i.nombre FROM instrumentos i
      JOIN profesor_instrumento pi ON i.id = pi.instrumento_id
      WHERE pi.profesor_id = $1
    `, [id]);

    const gruposRes = await db.query(`
      SELECT g.nombre FROM grupos g
      JOIN profesor_grupo pg ON g.id = pg.grupo_id
      WHERE pg.profesor_id = $1
    `, [id]);

    const nombresInstrumentos = instrumentosRes.rows.map(i => i.nombre);
    const nombresGrupos = gruposRes.rows.map(g => g.nombre);

    res.render('profesores_ficha', {
      profesor,
      instrumentos: nombresInstrumentos,
      grupos: nombresGrupos
    });
  } catch (err) {
    res.status(500).send('Error al obtener datos del profesor');
  }
});
router.put('/:id', upload.single('foto'), async (req, res) => {
  const id = req.params.id;
  const {
    nombre,
    apellidos,
    email,
    telefono,
    direccion,
    fecha_nacimiento,
    especialidad,
    instrumentos,
    grupos
  } = req.body;

  const activo = req.body.activo === '1';
  const foto = req.file ? req.file.filename : null;

  if (!nombre || !apellidos || !email) {
    return recargarFormulario('Nombre, apellidos y correo electrónico son obligatorios.');
  }

  try {
    // 1) Construir query UPDATE dinámicamente
    const campos = [
      'nombre = $1',
      'apellidos = $2',
      'email = $3',
      'telefono = $4',
      'direccion = $5',
      'fecha_nacimiento = $6',
      'especialidad = $7',
      'activo = $8'
    ];
    const params = [
      nombre, apellidos, email, telefono,
      direccion, fecha_nacimiento, especialidad, activo
    ];

    if (foto) {
      campos.push(`foto = $${params.length + 1}`);
      params.push(foto);
    }

    params.push(id);
    const updateQuery = `UPDATE profesores SET ${campos.join(', ')} WHERE id = $${params.length}`;
    await db.query(updateQuery, params);

    // 2) Limpiar relaciones anteriores
    await db.query('DELETE FROM profesor_instrumento WHERE profesor_id = $1', [id]);
    await db.query('DELETE FROM profesor_grupo WHERE profesor_id = $1', [id]);

    // 3) Insertar nuevas relaciones
    const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    const gruposArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];

    for (const instId of instrumentosArray) {
      await db.query(
        'INSERT INTO profesor_instrumento (profesor_id, instrumento_id) VALUES ($1, $2)',
        [id, instId]
      );
    }

    for (const grupoId of gruposArray) {
      await db.query(
        'INSERT INTO profesor_grupo (profesor_id, grupo_id) VALUES ($1, $2)',
        [id, grupoId]
      );
    }

    res.redirect(`/profesores/${id}`);
  } catch (err) {
    console.error('❌ Error actualizando profesor:', err);

    if (err.code === '23505') {
      return recargarFormulario('El correo electrónico ya está registrado.');
    }

    res.status(500).send('Error al actualizar el profesor');
  }

  // Función auxiliar
  async function recargarFormulario(error) {
    try {
      const gruposAll = (await db.query('SELECT * FROM grupos ORDER BY nombre')).rows;
      const instrumentosAll = (await db.query('SELECT * FROM instrumentos ORDER BY nombre')).rows;

      res.render('profesor_form', {
        error,
        profesor: {
          id,
          nombre,
          apellidos,
          email,
          telefono,
          direccion,
          fecha_nacimiento,
          especialidad,
          activo
        },
        grupos: gruposAll,
        instrumentos: instrumentosAll,
        gruposProfesor: Array.isArray(grupos) ? grupos.map(Number) : grupos ? [Number(grupos)] : [],
        instrumentosProfesor: Array.isArray(instrumentos) ? instrumentos.map(Number) : instrumentos ? [Number(instrumentos)] : [],
        hero: false
      });
    } catch (e) {
      console.error('❌ Error al recargar formulario con error:', e);
      res.status(500).send('Error al cargar el formulario');
    }
  }
});
module.exports = router;
