const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET: Mostrar formulario de nueva grupo
router.get('/nuevo', (req, res) => {
  res.render('grupos_ficha', { grupo: null });
});

// POST: Crear nueva grupo
router.post('/', (req, res) => {
  const { nombre, descripcion } = req.body;
  db.run('INSERT INTO grupos (nombre, descripcion) VALUES (?, ?)', [nombre, descripcion], (err) => {
    if (err) return res.status(500).send('Error al guardar el grupo');
    res.redirect('/grupos');
  });
});

// GET: Listado de grupos con búsqueda
router.get('/', (req, res) => {
  const busqueda = req.query.busqueda || '';
  const sql = busqueda
    ? 'SELECT * FROM grupos WHERE nombre LIKE ? OR descripcion LIKE ?'
    : 'SELECT * FROM grupos';

  const params = busqueda ? [`%${busqueda}%`, `%${busqueda}%`] : [];

  db.all(sql, params, (err, grupos) => {
    if (err) return res.status(500).send('Error al obtener grupos');
    res.render('grupos_lista', {
      grupos,
      busqueda,
      hero: false
    });
  });
});

// GET: Formulario de edición
router.get('/editar/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM grupos WHERE id = ?', [id], (err, grupo) => {
    if (err) return res.status(500).send('Error al cargar grupo');
    if (!grupo) return res.status(404).send('Grupo no encontrado');
    res.render('grupos_ficha', { grupo }); // 👈 Aquí se pasa `grupo`, no `grupos`
  });
});

// POST: Actualizar grupo
router.post('/editar/:id', (req, res) => {
  const id = req.params.id;
  const { nombre, descripcion } = req.body;
  db.run('UPDATE grupos SET nombre = ?, descripcion = ? WHERE id = ?', [nombre, descripcion, id], (err) => {
    if (err) return res.status(500).send('Error al actualizar grupo');
    res.redirect('/grupos');
  });  
});

router.post('/eliminar/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM grupos WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('Error al eliminar grupo');
    res.redirect('/grupos');
  });
});
// DELETE: Eliminar grupo
router.delete('/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM grupos WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Error al eliminar grupo:', err.message);
      return res.status(500).send('Error al eliminar grupo');
    }

    res.redirect('/grupos');
  });
});

module.exports = router;
