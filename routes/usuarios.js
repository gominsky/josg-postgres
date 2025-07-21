const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

// Mostrar formulario de creación de usuario
router.get('/nuevo', (req, res) => {
  res.render('usuarios_ficha', {
    usuario: null,     // fuerza que no haya usuario
    esEdicion: false   // indicamos que es creación
  });
});

router.post('/nuevo', async (req, res) => {
  const { nombre, apellidos, email, password, rol } = req.body;

  try {
    const hash = await bcrypt.hash(password, saltRounds);
    const sqlUser = `
      INSERT INTO usuarios (nombre, apellidos, email, password, rol, creado_en)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    db.run(sqlUser, [nombre, apellidos, email, hash, rol], function (err) {
      if (err) {
        console.error('Error al crear usuario:', err);
        return res.status(500).send('Error al guardar el usuario');
      }
      // Si el rol es docente, crear también entrada en profesores
      if (rol === 'docente') {
        const sqlProf = `
          INSERT INTO profesores (nombre, apellidos, email)
          VALUES (?, ?, ?)
        `;
        db.run(sqlProf, [nombre, apellidos, email], err2 => {
          if (err2) console.error('Error al añadir a la lista de docentes', err2);
          // no bloqueamos el flujo principal
          res.redirect('/usuarios/nuevo?exito=1');
        });
      } else {
        res.redirect('/usuarios/nuevo?exito=1');
      }
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
// Formulario edición (antes renderizaba usuarios_form)
router.get('/:id/editar', (req, res) => {
  db.get('SELECT * FROM usuarios WHERE id = ?', [req.params.id], (err, usuario) => {
    if (err || !usuario) return res.status(404).send('Usuario no encontrado');
    res.render('usuarios_ficha', {
      usuario,
      esEdicion: true
    });
  });
});

router.post('/:id/editar', async (req, res) => {
  const { nombre, apellidos, email, password, rol } = req.body;

  try {
    let sql, params;

    if (password && password.trim() !== '') {
      const hash = await bcrypt.hash(password, saltRounds);
      sql = `
        UPDATE usuarios
        SET nombre = ?, apellidos = ?, email = ?, password = ?, rol = ?
        WHERE id = ?
      `;
      params = [nombre, apellidos, email, hash, rol, req.params.id];
    } else {
      sql = `
        UPDATE usuarios
        SET nombre = ?, apellidos = ?, email = ?, rol = ?
        WHERE id = ?
      `;
      params = [nombre, apellidos, email, rol, req.params.id];
    }

    db.run(sql, params, err => {
      if (err) return res.status(500).send('Error al actualizar usuario');

      // Opcional: sincronizar tabla profesores si cambia rol
      if (rol === 'docente') {
        // Intentar UPDATE; si no existe, hacer INSERT
        const upd = `
          UPDATE profesores
          SET nombre = ?, apellidos = ?, email = ?
          WHERE email = ?
        `;
        db.run(upd, [nombre, apellidos, email, email], function(errUpd) {
          if (errUpd || this.changes === 0) {
            const ins = `
              INSERT OR IGNORE INTO profesores (nombre, apellidos, email)
              VALUES (?, ?, ?)
            `;
            db.run(ins, [nombre, apellidos, email]);
          }
          res.redirect('/usuarios');
        });
      } else {
        // Si cambió de docente a otro rol, borrar de profesores
        const del = `DELETE FROM profesores WHERE email = ?`;
        db.run(del, [email], () => res.redirect('/usuarios'));
      }
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
