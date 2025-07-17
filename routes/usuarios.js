const express = require('express');
const router = express.Router();
const db = require('../database/db');

// Mostrar formulario de creación de usuario
router.get('/nuevo', (req, res) => {
  res.render('usuarios_formulario');
});

// Procesar creación
router.post('/nuevo', (req, res) => {
  const { nombre, email, password, rol } = req.body;

  const sql = `
    INSERT INTO usuarios (nombre, email, password, rol, creado_en)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;
  db.run(sql, [nombre, email, password, rol], function (err) {
    if (err) {
      console.error('Error al crear usuario:', err);
      return res.status(500).send('Error al guardar el usuario');
    }
    res.redirect('/usuarios/nuevo?exito=1');
  });
});
// Listado
router.get('/', (req, res) => {
    db.all('SELECT * FROM usuarios ORDER BY nombre', (err, usuarios) => {
      if (err) return res.status(500).send('Error al obtener usuarios');
      res.render('usuarios_lista', { usuarios });
    });
  });
  
  // Formulario edición
  router.get('/:id/editar', (req, res) => {
    db.get('SELECT * FROM usuarios WHERE id = ?', [req.params.id], (err, usuario) => {
      if (err || !usuario) return res.status(404).send('Usuario no encontrado');
      res.render('usuarios_formulario', { usuario });
    });
  });
  
  // Guardar edición
  router.post('/:id/editar', (req, res) => {
    const { nombre, email, password, rol } = req.body;
    const sql = `
      UPDATE usuarios SET nombre = ?, email = ?, password = ?, rol = ?
      WHERE id = ?
    `;
    db.run(sql, [nombre, email, password, rol, req.params.id], (err) => {
      if (err) return res.status(500).send('Error al actualizar usuario');
      res.redirect('/usuarios');
    });
  });
  
  // Eliminar
  router.post('/:id/eliminar', (req, res) => {
    db.run('DELETE FROM usuarios WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).send('Error al eliminar usuario');
      res.redirect('/usuarios');
    });
  });
  
module.exports = router;
