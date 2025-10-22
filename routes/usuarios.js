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
// Upsert manual en profesores por email (sin ON CONFLICT)
async function upsertProfesorByEmail(dbOrClient, { nombre, apellidos, email }) {
  const sel = await dbOrClient.query(
    'SELECT id FROM profesores WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  if (sel.rows.length) {
    await dbOrClient.query(
      'UPDATE profesores SET nombre = $1, apellidos = $2, email = $3 WHERE id = $4',
      [nombre, apellidos, email, sel.rows[0].id]
    );
  } else {
    await dbOrClient.query(
      'INSERT INTO profesores (nombre, apellidos, email) VALUES ($1, $2, $3)',
      [nombre, apellidos, email]
    );
  }
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
  const allowedRoles = new Set(['usuario','docente','admin']);
  if (!allowedRoles.has(rol)) return res.status(400).send('Rol inválido.');
  if (password.length < 8) return res.status(400).send('La contraseña debe tener al menos 8 caracteres.');

  if (!email || !password) {
    return res.status(400).send('Faltan email y/o contraseña.');
  }

  try {
    const hash = await bcrypt.hash(password, saltRounds);

    const SQL_USER = `
      INSERT INTO usuarios (nombre, apellidos, email, password_hash, rol)
      VALUES ($1, $2, $3, $4, $5)
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

    if (rol === 'docente') {
        await upsertProfesorByEmail(db, { nombre, apellidos, email });
    }  // Si es docente, garantizamos su presencia en profesores (sin ON CONFLICT)
      
    res.redirect('/usuarios?creado=1');
  } catch (err) {
    console.error('Error al crear usuario:', err);
    res.status(500).send('Error al guardar el usuario');
  }
});

/* ====== LISTADO ====== */
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios ORDER BY nombre, apellidos');
    res.render('usuarios_lista', {
      usuarios: result.rows,
      creado: String(req.query.creado || '') === '1'
    });
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
  const allowedRoles = new Set(['usuario','docente','admin']);
  if (!allowedRoles.has(rol)) return res.status(400).send('Rol inválido.');
  if (password && password.trim() !== '' && password.length < 8) {
    return res.status(400).send('La contraseña debe tener al menos 8 caracteres.');
  }
  
  try {
    // Cargar usuario actual (para conocer el email anterior)
    const { rows: [oldUser] } = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (!oldUser) return res.status(404).send('Usuario no encontrado');
    const emailOld = String(oldUser.email || '').toLowerCase();

    await db.query('BEGIN');

    // UPDATE usuarios (con o sin password)
    let sql, params;
    if (password && password.trim() !== '') {
      const hash = await bcrypt.hash(password, saltRounds);
      sql = `
        UPDATE usuarios
        SET nombre = $1, apellidos = $2, email = $3, password_hash = $4, rol = $5
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
        await db.query('ROLLBACK');
        return res.status(400).send('Ese email ya está registrado.');
      }
      throw e;
    }
    if (rol === 'docente') {
  if (emailOld && emailOld !== emailNew) {
    // 1) Intento de actualizar por el email antiguo
    const upd = await db.query(
      `UPDATE profesores
         SET nombre = $1, apellidos = $2, email = $3
       WHERE LOWER(email) = LOWER($4)`,
      [nombre, apellidos, emailNew, emailOld]
    );

    if (upd.rowCount === 0) {
      // 2) Si no existía por emailOld, mira si ya hay fila con emailNew
      const sel = await db.query(
        'SELECT id FROM profesores WHERE LOWER(email) = LOWER($1)',
        [emailNew]
      );
      if (sel.rows.length) {
        await db.query(
          `UPDATE profesores
             SET nombre = $1, apellidos = $2
           WHERE id = $3`,
          [nombre, apellidos, sel.rows[0].id]
        );
      } else {
        await db.query(
          `INSERT INTO profesores (nombre, apellidos, email)
           VALUES ($1, $2, $3)`,
          [nombre, apellidos, emailNew]
        );
      }
    }
  } else {
    // Email no cambia: upsert manual por emailNew
    await upsertProfesorByEmail(db, { nombre, apellidos, email: emailNew });
  }
} else {
  // (tu rama “ya no es docente” sigue igual)
  const emails = [emailOld, emailNew].filter(Boolean);

  await db.query(`
    WITH p AS (SELECT id FROM profesores WHERE email = ANY($1))
    DELETE FROM profesor_instrumento pi
    USING p
    WHERE pi.profesor_id = p.id
  `, [emails]);

  await db.query(`
    WITH p AS (SELECT id FROM profesores WHERE email = ANY($1))
    DELETE FROM profesor_grupo pg
    USING p
    WHERE pg.profesor_id = p.id
  `, [emails]);

  await db.query(`DELETE FROM profesores WHERE email = ANY($1)`, [emails]);
}


    await db.query('COMMIT');
    res.redirect('/usuarios');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('Error al actualizar usuario:', err);
    res.status(500).send('Error interno');
  }
});


/* ====== ELIMINAR ====== */
router.post('/:id/eliminar', async (req, res) => {
  try {
    await db.query('BEGIN');

    // 1) Cargar el usuario para conocer su email
    const { rows: [u] } = await db.query(
      'SELECT email FROM usuarios WHERE id = $1',
      [req.params.id]
    );

    if (u && u.email) {
      const email = String(u.email || '').toLowerCase();

      // 2) Borrar relaciones que referencian a profesores (por su id)
      //    2.1 Instrumentos
      await db.query(`
        WITH p AS (SELECT id FROM profesores WHERE email = $1)
        DELETE FROM profesor_instrumento pi
        USING p
        WHERE pi.profesor_id = p.id
      `, [email]);

      //    2.2 Grupos
      await db.query(`
        WITH p AS (SELECT id FROM profesores WHERE email = $1)
        DELETE FROM profesor_grupo pg
        USING p
        WHERE pg.profesor_id = p.id
      `, [email]);

      // 3) Borrar la propia fila en profesores
      await db.query('DELETE FROM profesores WHERE email = $1', [email]);
    }

    // 4) Borrar el usuario
    await db.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);

    await db.query('COMMIT');
    res.redirect('/usuarios');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('Error al eliminar usuario:', err);
    res.status(500).send('Error al eliminar usuario');
  }
});


module.exports = router;
