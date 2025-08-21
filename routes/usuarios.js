const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

/* Utilidades */
async function resyncUsuariosSequence() {
  // Pone la secuencia al MAX(id); el siguiente nextval será MAX+1
  await db.query(`
    SELECT setval(pg_get_serial_sequence('usuarios','id'),
                  COALESCE((SELECT MAX(id) FROM usuarios), 0));
  `);
}
function isPKDuplicate(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('usuarios_pkey');
}
function isEmailDuplicate(err) {
  return err && err.code === '23505' && /email/i.test(String(err.constraint || err.detail || ''));
}

/* ====== NUEVO USUARIO ====== */
router.get('/nuevo', (req, res) => {
  res.render('usuarios_ficha', { usuario: null, esEdicion: false });
});

router.post('/nuevo', async (req, res) => {
  const nombre    = String(req.body?.nombre || '').trim();
  const apellidos = String(req.body?.apellidos || '').trim();
  const email     = String(req.body?.email || '').trim().toLowerCase();
  const password  = String(req.body?.password || '');
  const rol       = String(req.body?.rol || '').trim();

  if (!email || !password) {
    return res.status(400).send('Faltan email y/o contraseña.');
  }

  try {
    const hash = await bcrypt.hash(password, saltRounds);

    const SQL_USER = `
      INSERT INTO usuarios (nombre, apellidos, email, password, rol, creado_en)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id
    `;

    let userId;
    try {
      const r = await db.query(SQL_USER, [nombre, apellidos, email, hash, rol]);
      userId = r.rows[0].id;
    } catch (e) {
      // Si la secuencia está desincronizada, la reparamos y reintentamos una vez
      if (isPKDuplicate(e)) {
        await resyncUsuariosSequence();
        const r2 = await db.query(SQL_USER, [nombre, apellidos, email, hash, rol]);
        userId = r2.rows[0].id;
      } else if (isEmailDuplicate(e)) {
        return res.status(400).send('Ese email ya está registrado.');
      } else {
        throw e;
      }
    }

    // Si es docente, garantizamos su presencia en profesores (upsert por email)
    if (rol === 'docente') {
      await db.query(
        `INSERT INTO profesores (nombre, apellidos, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
           SET nombre = EXCLUDED.nombre, apellidos = EXCLUDED.apellidos`,
        [nombre, apellidos, email]
      );
    }

    res.redirect('/usuarios/nuevo?exito=1');
  } catch (err) {
    console.error('Error al crear usuario:', err);
    res.status(500).send('Error al guardar el usuario');
  }
});

/* ====== LISTADO ====== */
router.get('/', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios ORDER BY nombre, apellidos');
    res.render('usuarios_lista', { usuarios: result.rows });
  } catch (_err) {
    res.status(500).send('Error al obtener usuarios');
  }
});

/* ====== EDITAR ====== */
router.get('/:id/editar', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).send('Usuario no encontrado');

    res.render('usuarios_ficha', { usuario, esEdicion: true });
  } catch (_err) {
    res.status(500).send('Error al obtener usuario');
  }
});

router.post('/:id/editar', async (req, res) => {
  const id        = Number(req.params.id);
  const nombre    = String(req.body?.nombre || '').trim();
  const apellidos = String(req.body?.apellidos || '').trim();
  const emailNew  = String(req.body?.email || '').trim().toLowerCase();
  const password  = String(req.body?.password || '');
  const rol       = String(req.body?.rol || '').trim();

  try {
    // Cargamos el usuario actual para conocer su email anterior
    const { rows: [oldUser] } = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (!oldUser) return res.status(404).send('Usuario no encontrado');
    const emailOld = String(oldUser.email || '').toLowerCase();

    // Construimos UPDATE (con o sin password)
    let sql, params;
    if (password && password.trim() !== '') {
      const hash = await bcrypt.hash(password, saltRounds);
      sql = `
        UPDATE usuarios
        SET nombre = $1, apellidos = $2, email = $3, password = $4, rol = $5
        WHERE id = $6
      `;
      params = [nombre, apellidos, emailNew, hash, rol, id];
    } else {
      sql = `
        UPDATE usuarios
        SET nombre = $1, apellidos = $2, email = $3, rol = $4
        WHERE id = $5
      `;
      params = [nombre, apellidos, emailNew, rol, id];
    }

    try {
      await db.query(sql, params);
    } catch (e) {
      if (isEmailDuplicate(e)) {
        return res.status(400).send('Ese email ya está registrado.');
      }
      throw e;
    }

    // Sincronizar tabla profesores según el rol actual
    if (rol === 'docente') {
      // Si cambió el email, intentamos actualizar por el email antiguo
      if (emailOld && emailOld !== emailNew) {
        const upd = await db.query(
          `UPDATE profesores
             SET nombre = $1, apellidos = $2, email = $3
           WHERE email = $4`,
          [nombre, apellidos, emailNew, emailOld]
        );
        if (upd.rowCount === 0) {
          // No existía con el antiguo: upsert por el nuevo
          await db.query(
            `INSERT INTO profesores (nombre, apellidos, email)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE
               SET nombre = EXCLUDED.nombre, apellidos = EXCLUDED.apellidos`,
            [nombre, apellidos, emailNew]
          );
        }
      } else {
        // Email no cambió: upsert por el actual
        await db.query(
          `INSERT INTO profesores (nombre, apellidos, email)
           VALUES ($1, $2, $3)
           ON CONFLICT (email) DO UPDATE
             SET nombre = EXCLUDED.nombre, apellidos = EXCLUDED.apellidos`,
          [nombre, apellidos, emailNew]
        );
      }
    } else {
      // Ya no es docente: limpia por ambos emails por si hubo cambio
      await db.query(`DELETE FROM profesores WHERE email = ANY($1)`, [[emailOld, emailNew]]);
    }

    res.redirect('/usuarios');
  } catch (err) {
    console.error('Error al actualizar usuario:', err);
    res.status(500).send('Error interno');
  }
});

/* ====== ELIMINAR ====== */
router.post('/:id/eliminar', async (req, res) => {
  try {
    const { rows: [u] } = await db.query('SELECT email, rol FROM usuarios WHERE id = $1', [req.params.id]);
    if (u) {
      // Limpia profesor si existe (por seguridad)
      await db.query('DELETE FROM profesores WHERE email = $1', [String(u.email || '').toLowerCase()]);
    }
    await db.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    res.redirect('/usuarios');
  } catch (_err) {
    res.status(500).send('Error al eliminar usuario');
  }
});

module.exports = router;
