const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Mostrar formulario de nuevo grupo
router.get('/nuevo', (req, res) => {
  res.render('grupos_ficha', { grupo: null });
});

// POST: Crear nuevo grupo
router.post('/', async (req, res) => {
  const { nombre, descripcion } = req.body;

  try {
    await db.query(
      'INSERT INTO grupos (nombre, descripcion) VALUES ($1, $2)',
      [nombre, descripcion]
    );
    res.redirect('/grupos');
  } catch (err) {
    console.error('Error al guardar grupo:', err);
    res.status(500).send('Error al guardar el grupo');
  }
});

// GET: Listado de grupos con búsqueda + orden alfabético
router.get('/', async (req, res) => {
  const busqueda = (req.query.busqueda || '').trim();

  // Orden común (A→Z, case-insensitive)
  const ORDER = 'ORDER BY lower(nombre) ASC, id ASC';

  // Si hay búsqueda, filtramos y mantenemos el orden alfabético
  const sql = busqueda
    ? `SELECT * FROM grupos
       WHERE nombre ILIKE $1 OR descripcion ILIKE $2
       ${ORDER}`
    : `SELECT * FROM grupos
       ${ORDER}`;

  const params = busqueda ? [`%${busqueda}%`, `%${busqueda}%`] : [];

  try {
    const result = await db.query(sql, params);
    res.render('grupos_lista', {
      grupos: result.rows,
      busqueda,
      hero: false
    });
  } catch (err) {
    console.error('Error al obtener grupos:', err);
    res.status(500).send('Error al obtener grupos');
  }
});

// GET: Formulario de edición
router.get('/editar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const result = await db.query('SELECT * FROM grupos WHERE id = $1', [id]);
    const grupo = result.rows[0];

    if (!grupo) return res.status(404).send('Grupo no encontrado');
    res.render('grupos_ficha', { grupo });
  } catch (err) {
    console.error('Error al cargar grupo:', err);
    res.status(500).send('Error al cargar grupo');
  }
});

// POST: Actualizar grupo
router.post('/editar/:id', async (req, res) => {
  const id = req.params.id;
  const { nombre, descripcion } = req.body;

  try {
    await db.query(
      'UPDATE grupos SET nombre = $1, descripcion = $2 WHERE id = $3',
      [nombre, descripcion, id]
    );
    res.redirect('/grupos');
  } catch (err) {
    console.error('Error al actualizar grupo:', err);
    res.status(500).send('Error al actualizar grupo');
  }
});

// POST: Eliminar grupo
router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.query('DELETE FROM grupos WHERE id = $1', [id]);
    res.redirect('/grupos');
  } catch (err) {
    console.error('Error al eliminar grupo:', err);
    res.status(500).send('Error al eliminar grupo');
  }
});

// DELETE: Eliminar grupo limpiando relaciones (NO borra alumnos/profesores) y avisando
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('BEGIN');

    // 1) Borrar filas de tablas puente (solo relaciones)
    const delAG = await db.query('DELETE FROM alumno_grupo   WHERE grupo_id = $1', [id]);
    const delPG = await db.query('DELETE FROM profesor_grupo WHERE grupo_id = $1', [id]);

    // 2) Borrar el grupo
    const delG = await db.query('DELETE FROM grupos WHERE id = $1', [id]);

    await db.query('COMMIT');

    const msg = delG.rowCount
      ? `Grupo borrado. Relaciones eliminadas: ${delAG.rowCount} alumno(s)-grupo y ${delPG.rowCount} profesor(es)-grupo.`
      : 'El grupo no existía (0 filas).';
    return res.redirect(`/grupos?notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    console.error('Error al eliminar grupo:', err);
    await db.query('ROLLBACK');
    const warn = 'No se pudo borrar el grupo. Revisa relaciones o permisos.';
    return res.redirect(`/grupos?warning=${encodeURIComponent(warn)}`);
  }
});


module.exports = router;
