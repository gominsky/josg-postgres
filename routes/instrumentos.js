const express = require('express');
const router = express.Router();
const db = require('../database/db');
const methodOverride = require('method-override');
router.use(methodOverride('_method'));

const FAMILIAS = [
  'Cuerda',
  'Percusión',
  'Viento madera',
  'Viento metal',
  'Otra'
];

// GET: Listado de instrumentos
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM instrumentos ORDER BY nombre');
    res.render('instrumentos_lista', { instrumentos: result.rows });
  } catch (err) {
    console.error('❌ Error cargando instrumentos:', err.message);
    res.status(500).send('Error cargando instrumentos');
  }
});

// GET: Formulario para nuevo instrumento
router.get('/nuevo', (req, res) => {
  res.render('instrumentos_ficha', { instrumento: null, familias: FAMILIAS });
});

// GET: Formulario para editar instrumento
router.get('/:id/editar', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query('SELECT * FROM instrumentos WHERE id = $1', [id]);
    const instrumento = result.rows[0];
    if (!instrumento) return res.status(404).send('Instrumento no encontrado');
    res.render('instrumentos_ficha', { instrumento, familias: FAMILIAS });
  } catch (err) {
    console.error('❌ Error al obtener instrumento:', err.message);
    res.status(500).send('Error al cargar instrumento');
  }
});

// POST: Crear nuevo instrumento
router.post('/', async (req, res) => {
  const { nombre, familia } = req.body;
  try {
    await db.query('INSERT INTO instrumentos (nombre, familia) VALUES ($1, $2)', [nombre, familia]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al guardar instrumento:', err.message);
    res.status(500).send('Error al guardar instrumento');
  }
});

// POST: Actualizar instrumento (desde formulario)
router.post('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, familia } = req.body;
  try {
    await db.query('UPDATE instrumentos SET nombre = $1, familia = $2 WHERE id = $3', [nombre, familia, id]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al actualizar instrumento:', err.message);
    res.status(500).send('Error al actualizar instrumento');
  }
});

// PUT: Actualizar instrumento (RESTful)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, familia } = req.body;
  try {
    await db.query('UPDATE instrumentos SET nombre = $1, familia = $2 WHERE id = $3', [nombre, familia, id]);
    res.redirect('/instrumentos');
  } catch (err) {
    console.error('❌ Error al actualizar instrumento:', err.message);
    res.status(500).send('Error al actualizar instrumento');
  }
});

// DELETE: Eliminar instrumento limpiando relaciones (NO borra alumnos/profesores) y avisando
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('BEGIN');

    // 1) Borrar filas de tablas puente (solo relaciones)
    const delAI   = await db.query('DELETE FROM alumno_instrumento    WHERE instrumento_id = $1', [id]);
    const delPI   = await db.query('DELETE FROM profesor_instrumento  WHERE instrumento_id = $1', [id]);
    const delPIns = await db.query('DELETE FROM partitura_instrumento WHERE instrumento_id = $1', [id]); // relación partitura-instrumento

    // 2) Borrar el instrumento
    const delI = await db.query('DELETE FROM instrumentos WHERE id = $1', [id]);

    await db.query('COMMIT');

    const msg = delI.rowCount
      ? `Instrumento borrado. Relaciones eliminadas: ${delAI.rowCount} alumno(s), ${delPI.rowCount} profesor(es), ${delPIns.rowCount} partitura(s)-instrumento.`
      : 'El instrumento no existía (0 filas).';
    return res.redirect(`/instrumentos?notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    console.error('❌ Error al eliminar instrumento:', err);
    await db.query('ROLLBACK');
    const warn = 'No se pudo borrar el instrumento. Revisa relaciones o permisos.';
    return res.redirect(`/instrumentos?warning=${encodeURIComponent(warn)}`);
  }
});

module.exports = router;
