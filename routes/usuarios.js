const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

// Mostrar formulario de creación de usuario
router.get('/nuevo', (req, res) => {
  res.render('usuarios_form'); 
});

// Procesar creación
router.post('/nuevo', async (req, res) => {
  const { nombre, email, password, rol } = req.body;

  try {
    const hash = await bcrypt.hash(password, saltRounds);
    const sql = `
      INSERT INTO usuarios (nombre, email, password, rol, creado_en)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    db.run(sql, [nombre, email, hash, rol], function (err) {
      if (err) {
        console.error('Error al crear usuario:', err);
        return res.status(500).send('Error al guardar el usuario');
      }
      res.redirect('/usuarios/nuevo?exito=1');
    });
  } catch (err) {
    console.error('Error en hash:', err);
    res.status(500).send('Error interno');
  }
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
      res.render('usuarios_form', { usuario });
    });
  });
  
  // Guardar edición
  router.post('/:id/editar', async (req, res) => {
    const { nombre, email, password, rol } = req.body;
  
    try {
      let sql, params;
  
      if (password && password.trim() !== '') {
        const hash = await bcrypt.hash(password, saltRounds);
        sql = `
          UPDATE usuarios SET nombre = ?, email = ?, password = ?, rol = ?
          WHERE id = ?
        `;
        params = [nombre, email, hash, rol, req.params.id];
      } else {
        sql = `
          UPDATE usuarios SET nombre = ?, email = ?, rol = ?
          WHERE id = ?
        `;
        params = [nombre, email, rol, req.params.id];
      }
  
      db.run(sql, params, (err) => {
        if (err) return res.status(500).send('Error al actualizar usuario');
        res.redirect('/usuarios');
      });
  
    } catch (err) {
      console.error('Error al actualizar usuario:', err);
      res.status(500).send('Error interno');
    }
  });
  
  // Eliminar
  router.post('/:id/eliminar', (req, res) => {
    db.run('DELETE FROM usuarios WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).send('Error al eliminar usuario');
      res.redirect('/usuarios');
    });
  });
  
module.exports = router;
