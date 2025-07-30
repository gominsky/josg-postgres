const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

// Mostrar formulario de creación de usuario
router.get('/nuevo', (req, res) => {
  res.render('usuarios_ficha', {
    usuario: null,
    esEdicion: false
  });
});

router.post('/nuevo', async (req, res) => {
  const { nombre, apellidos, email, password, rol } = req.body;

  try {
    const hash = await bcrypt.hash(password, saltRounds);
    const sqlUser = `
      INSERT INTO usuarios (nombre, apellidos, email, password, rol, creado_en)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    `;
    await db.query(sqlUser, [nombre, apellidos, email, hash, rol]);

    if (rol === 'docente') {
      const sqlProf = `
        INSERT INTO profesores (nombre, apellidos, email)
        VALUES ($1, $2, $3)
      `;
      await db.query(sqlProf, [nombre, apellidos, email]);
    }

    res.redirect('/usuarios/nuevo?exito=1');
  } catch (err) {
    console.error('Error al crear usuario:', err);
    res.status(500).send('Error al guardar el usuario');
  }
});

// Listado
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios ORDER BY nombre');
    res.render('usuarios_lista', { usuarios: result.rows });
  } catch (err) {
    res.status(500).send('Error al obtener usuarios');
  }
});

// Formulario edición
router.get('/:id/editar', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).send('Usuario no encontrado');

    res.render('usuarios_ficha', {
      usuario,
      esEdicion: true
    });
  } catch (err) {
    res.status(500).send('Error al obtener usuario');
  }
});

router.post('/:id/editar', async (req, res) => {
  const { nombre, apellidos, email, password, rol } = req.body;

  try {
    let sql, params;

    if (password && password.trim() !== '') {
      const hash = await bcrypt.hash(password, saltRounds);
      sql = `
        UPDATE usuarios
        SET nombre = $1, apellidos = $2, email = $3, password = $4, rol = $5
        WHERE id = $6
      `;
      params = [nombre, apellidos, email, hash, rol, req.params.id];
    } else {
      sql = `
        UPDATE usuarios
        SET nombre = $1, apellidos = $2, email = $3, rol = $4
        WHERE id = $5
      `;
      params = [nombre, apellidos, email, rol, req.params.id];
    }

    await db.query(sql, params);

    if (rol === 'docente') {
      const upd = `
        UPDATE profesores
        SET nombre = $1, apellidos = $2, email = $3
        WHERE email = $4
      `;
      const result = await db.query(upd, [nombre, apellidos, email, email]);
      if (result.rowCount === 0) {
        const ins = `
          INSERT INTO profesores (nombre, apellidos, email)
          VALUES ($1, $2, $3)
          ON CONFLICT (email) DO NOTHING
        `;
        await db.query(ins, [nombre, apellidos, email]);
      }
    } else {
      const del = `DELETE FROM profesores WHERE email = $1`;
      await db.query(del, [email]);
    }

    res.redirect('/usuarios');
  } catch (err) {
    console.error('Error al actualizar usuario:', err);
    res.status(500).send('Error interno');
  }
});

// Eliminar
router.post('/:id/eliminar', async (req, res) => {
  try {
    await db.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    res.redirect('/usuarios');
  } catch (err) {
    res.status(500).send('Error al eliminar usuario');
  }
});

module.exports = router;
