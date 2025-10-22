const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
// --- Subidas: ruta absoluta y carpeta garantizada ---
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// --- Multer con límites y tipos ---
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueName = `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato de imagen no permitido'), ok);
  }
});
async function safeUnlinkFromUploads(filename) {
  if (!filename) return;
  try { await fsp.unlink(path.join(UPLOADS_DIR, filename)); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[profesores] unlink:', filename, e.code); }
}
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
  const client = await db.connect();
  try {
    const {
      nombre, apellidos, email, telefono,
      direccion, fecha_nacimiento, especialidad,
      instrumentos, grupos
    } = req.body;

    const activo = req.body.activo === '1';
    const foto = req.file ? req.file.filename : null;

    await client.query('BEGIN');

    const insert = await client.query(`
      INSERT INTO profesores (
        nombre, apellidos, email, telefono, direccion,
        fecha_nacimiento, especialidad, foto, activo
      )
      VALUES (
        $1, $2, $3, $4, $5,
        NULLIF($6,'')::date, $7, $8, $9
      )
      RETURNING id
    `, [nombre, apellidos, email, telefono, direccion, fecha_nacimiento || '', especialidad, foto, activo]);

    const profesorId = insert.rows[0].id;

    const toArr = v => Array.isArray(v) ? v : (v ? [v] : []);

    for (const instId of toArr(instrumentos)) {
      await client.query(
        'INSERT INTO profesor_instrumento (profesor_id, instrumento_id) VALUES ($1, $2)',
        [profesorId, instId]
      );
    }

    for (const grupoId of toArr(grupos)) {
      await client.query(
        'INSERT INTO profesor_grupo (profesor_id, grupo_id) VALUES ($1, $2)',
        [profesorId, grupoId]
      );
    }

    await client.query('COMMIT');
    return res.redirect('/profesores');

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
    if (err.code === '23505') {
      return renderFormularioConError('El correo electrónico ya está registrado.');
    }
    console.error('Error al registrar el profesor:', err);
    return res.status(500).send('Error al registrar el profesor');
  } finally {
    client.release();
  }

  async function renderFormularioConError(mensaje) {
    try {
      const gruposAll = (await db.query('SELECT * FROM grupos')).rows;
      const instrumentosAll = (await db.query('SELECT * DE instrumentos')).rows;

      return res.render('profesor_form', {
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
    } catch (e) {
      return res.status(500).send('Error al cargar formulario con error');
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
    fecha_nacimiento, // puede venir '' desde <input type="date">
    especialidad,
    instrumentos,
    grupos,
    eliminar_foto,
    fotoActual
  } = req.body;

  const activo = req.body.activo === '1';
    // --- Reglas foto (igual que alumnos): eliminar/descartar/aceptar ---
  const fotoActualNombre = fotoActual || null;
  let foto = fotoActualNombre;
  if (req.file && fotoActualNombre && eliminar_foto !== '1') {
    await safeUnlinkFromUploads(req.file.filename); // descarta nueva
  }
  if (eliminar_foto === '1' && fotoActualNombre) {
    await safeUnlinkFromUploads(fotoActualNombre);
    foto = null;
  }
  if (!foto && req.file) {
    foto = req.file.filename; // no había foto → acepta
  }

  if (!nombre || !apellidos || !email) {
    return recargarFormulario('Nombre, apellidos y correo electrónico son obligatorios.');
  }

  try {
    // === 1) UPDATE dinámico con placeholders correctos ===
    const campos = [];
    const params = [];

    // helper para ir añadiendo campos sin “contar a mano” $1, $2…
    const set = (col, val, kind) => {
      params.push(val);
      const i = params.length;
      if (kind === 'dateOrNull') {
        campos.push(`${col} = NULLIF($${i}, '')::date`); // <-- clave del fix
      } else {
        campos.push(`${col} = $${i}`);
      }
    };

    set('nombre', nombre);
    set('apellidos', apellidos);
    set('email', email);
    set('telefono', telefono);
    set('direccion', direccion);
    set('fecha_nacimiento', fecha_nacimiento, 'dateOrNull'); // <-- aquí evita el 22007
    set('especialidad', especialidad);
    set('activo', activo);

     if (typeof foto !== 'undefined') set('foto', foto);

    params.push(id);
    const updateQuery = `UPDATE profesores SET ${campos.join(', ')} WHERE id = $${params.length}`;
    await db.query(updateQuery, params);

    // === 2) Limpiar relaciones anteriores ===
    await db.query('DELETE FROM profesor_instrumento WHERE profesor_id = $1', [id]);
    await db.query('DELETE FROM profesor_grupo WHERE profesor_id = $1', [id]);

    // === 3) Insertar nuevas relaciones ===
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

    return res.redirect(`/profesores/${id}`);
  } catch (err) {
    console.error('❌ Error actualizando profesor:', err);

    if (err.code === '23505') {
      if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
      return recargarFormulario('El correo electrónico ya está registrado.');
    }

    if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
    return res.status(500).send('Error al actualizar el profesor');
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
          fecha_nacimiento, // mostramos lo que vino del form
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

// DELETE: Eliminar profesor
router.post('/:id/eliminar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).send('ID inválido');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Obtener la foto antes de borrar
    const { rows } = await client.query(
      'SELECT foto FROM profesores WHERE id = $1',
      [id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Profesor no encontrado');
    }
    const foto = rows[0].foto;

    // 2) Borrar relaciones
    await client.query('DELETE FROM profesor_instrumento WHERE profesor_id = $1', [id]);
    await client.query('DELETE FROM profesor_grupo WHERE profesor_id = $1', [id]);

    // 3) Borrar el profesor
    await client.query('DELETE FROM profesores WHERE id = $1', [id]);

    await client.query('COMMIT');

    // 4) Borrar la foto del disco (fuera de la transacción)
    await safeUnlinkFromUploads(foto);

    return res.redirect('/profesores');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Error al eliminar profesor:', err);
    return res.status(500).send('Error al eliminar profesor');
  } finally {
    client.release();
  }
});

module.exports = router;
