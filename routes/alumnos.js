const express = require('express');
const router = express.Router();

const db = require('../database/db');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multer = require('multer');
const crypto = require('crypto');
const { toISODate } = require('../utils/fechas');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ───────────── Multer ─────────────
const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif' // iPhone
]);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] ||
                (path.extname(file.originalname) || '').toLowerCase() || '.bin';
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED.has(file.mimetype);
    cb(ok ? null : new Error('Formato no permitido (JPG/PNG/WEBP/HEIC)'), ok);
  }
});
function withUpload(handler) {
  return (req, res, next) => {
    upload.single('foto')(req, res, (err) => {
      if (!err) return handler(req, res, next);
      console.error('[upload] fallo:', err);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen supera el tamaño máximo (10MB).'
        : (err.message || 'No se pudo subir la imagen.');
      return res.status(400).send(msg);
    });
  };
}

// ───────────── Helpers de DB/metadata ─────────────
async function tableExists(name) {
  const { rows } = await db.query('SELECT to_regclass($1) t', [`public.${name}`]);
  return Boolean(rows[0]?.t);
}
async function columnExists(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}
async function ensureAlumnosApp() {
  if (!(await tableExists('alumnos_app'))) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS alumnos_app (
        alumno_id  INT PRIMARY KEY REFERENCES alumnos(id) ON DELETE CASCADE,
        email      TEXT,
        password   TEXT,
        registrado BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT now()
      );
    `);
  }
}

// ───────────── Helpers de saneo (NUEVO: globales) ─────────────
const toIntOrNull = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const toStrOrNull = (v) => (v === undefined || v === null) ? null : (String(v).trim() || null);
const toDateOrNull = (v) => v ? String(v).slice(0, 10) : null;

async function safeUnlinkFromUploads(filename) {
  if (!filename) return;
  const abs = path.join(UPLOADS_DIR, filename);
  try { await fsp.unlink(abs); } 
  catch (e) { if (e.code !== 'ENOENT') console.warn('[alumnos] unlink fallo:', abs, e.code || e.message); }
}

// ───────────── Credenciales app alumnos ─────────────
async function upsertCreds({ alumnoId, email, registrado, plainPassword }) {
  const hasColumnPassword = await columnExists('alumnos', 'password');

  // 1) registrado siempre vive en alumnos (porque tu ficha lo lee de ahí)
  await db.query('UPDATE alumnos SET registrado = $1 WHERE id = $2', [!!registrado, alumnoId]);

  // 2) password: si existe columna en alumnos, úsala; si no, usa alumnos_app
  if (plainPassword && plainPassword.trim() !== '') {
    const hash = await bcrypt.hash(plainPassword, 10);

    if (hasColumnPassword) {
      await db.query('UPDATE alumnos SET password = $1 WHERE id = $2', [hash, alumnoId]);
    } else {
      await ensureAlumnosApp();
      await db.query(
        `INSERT INTO alumnos_app (alumno_id, email, password, registrado, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (alumno_id)
         DO UPDATE SET email=EXCLUDED.email, password=EXCLUDED.password, registrado=EXCLUDED.registrado, updated_at=now()`,
        [alumnoId, email || null, hash, !!registrado]
      );
    }
  } else {
    // Si sólo cambia “registrado” y tienes alumnos_app, reflejamos el flag
    if (await tableExists('alumnos_app')) {
      await db.query(
        `INSERT INTO alumnos_app (alumno_id, email, registrado, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (alumno_id)
         DO UPDATE SET email=EXCLUDED.email, registrado=EXCLUDED.registrado, updated_at=now()`,
        [alumnoId, email || null, !!registrado]
      );
    }
  }
}

// ───────────── Formularios ─────────────
router.get('/nuevo', async (req, res) => {
  try {
    const instrumentos = (await db.query('SELECT * FROM instrumentos')).rows;
    const grupos = (await db.query('SELECT * FROM grupos')).rows;

    res.render('alumno', {
      alumno: null,
      instrumentos,
      instrumentosAlumno: [],
      grupos,
      gruposAlumno: [],
      hero: false,
      modoEditar: true
    });
  } catch (err) {
    res.status(500).send('Error al cargar instrumentos o grupos');
  }
});

// Crear alumno (con relaciones instrumentos/grupos)
router.post('/', upload.single('foto'), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const {
      // datos base
      nombre, apellidos, tutor, direccion,
      codigo_postal, cp, municipio, provincia,
      telefono, email, fecha_nacimiento, DNI, dni,
      centro, profesor_centro, repertorio_id,
      registrado, activo, password,
      guardias_actual, guardias_hist,
      fecha_matriculacion, fecha_alta, fecha_baja,

      // relaciones (select multiple)
      instrumentos, grupos
    } = req.body;

    // normalizaciones
    const normalizedEmail = normEmail(email);
    const DNI_val = (DNI ?? dni ?? '').trim() || null;
    const codigo_postal_val = codigo_postal ?? cp ?? null;
    const fecha_matriculacion_val =
    fecha_matriculacion ?? fecha_alta ?? new Date().toISOString().slice(0, 10);
    const fecha_baja_val = fecha_baja ?? null;

    // booleans reales
    const toBool = (v) => {
      const s = String(v ?? '').toLowerCase();
      return s === '1' || s === 'true' || s === 'on';
    };
    const activoBool = toBool(activo);
    // Si está inactivo, registrado debe ser false (sin acceso)
    let registradoBool = toBool(registrado);
    if (!activoBool) registradoBool = false;
    // --- Validar duplicados ---
    if (DNI_val) {
      const dupDni = await client.query(
        `SELECT 1 FROM alumnos WHERE dni = $1 LIMIT 1`,
        [DNI_val]
      );
      if (dupDni.rowCount > 0) {
        if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
        await client.query('ROLLBACK');
        return res.status(409).send('El DNI ya está registrado');
      }
    }
    if (normalizedEmail) {
      const dupEmail = await client.query(
        `SELECT 1 FROM alumnos WHERE email IS NOT NULL AND LOWER(email) = $1 LIMIT 1`,
        [normalizedEmail]
      );
      if (dupEmail.rowCount > 0) {
        if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }

        await client.query('ROLLBACK');
        return res.status(409).send('El email ya está registrado');
      }
    }

    // foto
    const foto = req.file ? req.file.filename : null;

    // payload alumno
    const payload = {
      nombre: toStrOrNull(nombre),
      apellidos: toStrOrNull(apellidos),
      tutor: toStrOrNull(tutor),
      direccion: toStrOrNull(direccion),
      codigo_postal: toIntOrNull(codigo_postal_val),
      municipio: toStrOrNull(municipio),
      provincia: toStrOrNull(provincia),
      telefono: toStrOrNull(telefono),
      email: toStrOrNull(normalizedEmail),
      fecha_nacimiento: toDateOrNull(fecha_nacimiento),
      dni: toStrOrNull(DNI_val),
      centro: toStrOrNull(centro),
      profesor_centro: toStrOrNull(profesor_centro),
      repertorio_id: toIntOrNull(repertorio_id),
      foto: toStrOrNull(foto),
      activo: activoBool,
      //password: toStrOrNull(password),
      registrado: registradoBool,
      fecha_matriculacion: toDateOrNull(fecha_matriculacion_val),
      fecha_baja: toDateOrNull(fecha_baja_val)
      // created_at / updated_at -> defaults
    };
    // Solo incluir guardias_* si llegan explícitamente y con número válido
    const ga = toIntOrNull(guardias_actual);
    const gh = toIntOrNull(guardias_hist);

    if (Object.prototype.hasOwnProperty.call(req.body, 'guardias_actual') && ga !== null) {
      payload.guardias_actual = ga;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'guardias_hist') && gh !== null) {
      payload.guardias_hist = gh;
    }
    // INSERT alumno y obtener id
    const fields = Object.keys(payload).join(', ');
    const placeholders = Object.keys(payload).map((_, i) => `$${i + 1}`).join(', ');
    const values = Object.values(payload);

    const ins = await client.query(
      `INSERT INTO alumnos (${fields}) VALUES (${placeholders}) RETURNING id`,
      values
    );
    const newId = ins.rows[0].id;

    // ---------- Relaciones ----------
    // Normalizar arrays desde el form (acepta valor único o array)
    const toIdArray = (v) => {
      const arr = Array.isArray(v) ? v : (v ? [v] : []);
      // números únicos y válidos
      return [...new Set(arr.map(n => parseInt(n, 10)).filter(Number.isFinite))];
    };

    const instIds = toIdArray(instrumentos);
    const grpIds  = toIdArray(grupos);

    if (instIds.length) {
      const sql = 'INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES ($1, $2)';
      for (const iid of instIds) {
        await client.query(sql, [newId, iid]);
      }
    }

    if (grpIds.length) {
      const sql = 'INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES ($1, $2)';
      for (const gid of grpIds) {
        await client.query(sql, [newId, gid]);
      }
    }

    // ---------- Credenciales app (si tienes la función arriba en el archivo) ----------
 
    await client.query('COMMIT');
    // ---------- Credenciales app (fuera de la transacción) ----------
    if (typeof upsertCreds === 'function') {
      await upsertCreds({
        alumnoId: newId,
        email: normalizedEmail,
        registrado: registradoBool,
        plainPassword: password || ''
      });
    }

    res.redirect('/alumnos');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear alumno:', err);
    // limpiar foto subida si algo falla
    if (req.file?.filename) {
      if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
    }
    res.status(500).send('Error al crear alumno');
  } finally {
    client.release();
  }
});

// Centro de ayuda (en Configuración)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_alumnos', { title: 'Ayuda · Alumnos', hero: false });
});
// Alias de ayuda
router.get(['/alumnos/ayuda', '/musicos/ayuda'], (_req, res) => {
  res.render('ayuda_musicos', { title: 'Ayuda · Músicos', hero: false });
});
// Normaliza email (lowercase + trim). Devuelve null si queda vacío
const normEmail = (e) => {
  const v = (e ?? '').toString().trim().toLowerCase();
  return v.length ? v : null;
};

// API: comprobar si un email está libre. Opcionalmente excluir un id (edición)
router.get('/api/check-email', async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const excludeId = parseInt(req.query.excludeId, 10) || null;
    if (!email) return res.json({ ok: true }); // vacío no se considera ocupado

    const params = [email];
    let sql = `SELECT 1 FROM alumnos WHERE email IS NOT NULL AND LOWER(email) = $1`;
    if (excludeId) {
      params.push(excludeId);
      sql += ` AND id <> $2`;
    }

    const { rows } = await db.query(sql, params);
    return res.json({ ok: rows.length === 0 });
  } catch (err) {
    console.error('[check-email] error:', err);
    return res.status(500).json({ ok: false });
  }
});
// API: comprobar si un DNI está libre. Opcionalmente excluir un id (edición)
router.get('/api/check-dni', async (req, res) => {
  try {
    const dni = (req.query.dni ?? '').toString().trim();
    const excludeId = parseInt(req.query.excludeId, 10) || null;
    if (!dni) return res.json({ ok: true }); // vacío: no bloquea

    const params = [dni];
    let sql = `SELECT 1 FROM alumnos WHERE dni = $1`;
    if (excludeId) {
      sql += ` AND id <> $2`;
      params.push(excludeId);
    }

    const { rows } = await db.query(sql, params);
    return res.json({ ok: rows.length === 0 });
  } catch (err) {
    console.error('[check-dni] error:', err);
    return res.status(500).json({ ok: false });
  }
});

// Actualizar alumno (sin bloqueos: upsertCreds tras COMMIT)
router.put('/:id', upload.single('foto'), async (req, res) => {
  const client = await db.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send('ID inválido');

    await client.query('BEGIN');

    const {
      nombre, apellidos, tutor, direccion,
      codigo_postal, cp, municipio, provincia,
      telefono, email, fecha_nacimiento, DNI, dni,
      centro, profesor_centro, repertorio_id,
      registrado, activo, password,
      guardias_actual, guardias_hist,
      fecha_matriculacion, fecha_alta, fecha_baja,
      eliminar_foto, fotoActual,
      instrumentos, grupos
    } = req.body;

    // Normalizaciones
    const normalizedEmail = normEmail(email);
    const codigo_postal_val = codigo_postal ?? cp ?? null;

    // DNI: solo si viene en el body (evita borrarlo)
    const dniKeyPresent = Object.prototype.hasOwnProperty.call(req.body, 'DNI')
                       || Object.prototype.hasOwnProperty.call(req.body, 'dni');
    const DNI_raw = dniKeyPresent ? (DNI ?? dni ?? '') : undefined;
    const DNI_val = dniKeyPresent ? DNI_raw.toString().trim() : undefined;
    const dniProvided = dniKeyPresent && DNI_val && DNI_val.length > 0;

    // Foto
    // Foto (no permitir nueva subida si existe foto actual y no se marca eliminar)
const fotoActualNombre = fotoActual || null;
let foto = fotoActualNombre;

// Si el usuario intenta subir una nueva foto sin eliminar la actual, la descartamos para no ocupar disco
if (req.file && fotoActualNombre && eliminar_foto !== '1') {
  await safeUnlinkFromUploads(req.file.filename);
}

// Si marca eliminar, borramos la actual y dejamos foto en null
if (eliminar_foto === '1' && fotoActualNombre) {
  await safeUnlinkFromUploads(fotoActualNombre);
  foto = null;
}

// Si no hay foto actual (o ya se eliminó) y se sube una nueva, la aceptamos
if (!foto && req.file) {
  foto = req.file.filename;
}

    // Bools
    const toBool = (v) => { const s = String(v ?? '').toLowerCase(); return s === '1' || s === 'true' || s === 'on'; };
    const activoBool = toBool(activo);
    // Si está inactivo, registrado debe ser false (sin acceso)
    let registradoBool = toBool(registrado);
    if (!activoBool) registradoBool = false;

    // fecha_baja: si no llega y pasas a inactivo => hoy; si activo => null
    const fecha_baja_val = fecha_baja ?? (activoBool ? null : new Date().toISOString().slice(0, 10));

    // Email duplicado (excluyéndome)
    if (normalizedEmail) {
      const dupEmail = await client.query(
        `SELECT 1 FROM alumnos WHERE email IS NOT NULL AND LOWER(email) = $1 AND id <> $2 LIMIT 1`,
        [normalizedEmail, id]
      );
      if (dupEmail.rowCount > 0) {
        if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
        await client.query('ROLLBACK');
        return res.status(409).send('El email ya está registrado');
      }
    }

    // DNI duplicado SOLO si vino
    if (dniProvided) {
      const dupDni = await client.query(
        `SELECT 1 FROM alumnos WHERE dni = $1 AND id <> $2 LIMIT 1`,
        [DNI_val, id]
      );
      if (dupDni.rowCount > 0) {
        if (req.file?.filename) { await safeUnlinkFromUploads(req.file.filename); }
        await client.query('ROLLBACK');
        return res.status(409).send('El DNI ya está registrado');
      }
    }

    // ---------- UPDATE alumno (sin password ni fecha_matriculacion por defecto) ----------
    const payload = {
      nombre: toStrOrNull(nombre),
      apellidos: toStrOrNull(apellidos),
      tutor: toStrOrNull(tutor),
      direccion: toStrOrNull(direccion),
      codigo_postal: toIntOrNull(codigo_postal_val),
      municipio: toStrOrNull(municipio),
      provincia: toStrOrNull(provincia),
      telefono: toStrOrNull(telefono),
      email: toStrOrNull(normalizedEmail),
      fecha_nacimiento: toDateOrNull(fecha_nacimiento),
      centro: toStrOrNull(centro),
      profesor_centro: toStrOrNull(profesor_centro),
      repertorio_id: toIntOrNull(repertorio_id),
      foto: toStrOrNull(foto),
      activo: activoBool,
      registrado: registradoBool,
      fecha_baja: toDateOrNull(fecha_baja_val)
        };
        // Solo actualizar guardias si llegan explícitamente y con número válido
    if (Object.prototype.hasOwnProperty.call(req.body, 'guardias_actual')) {
      const v = toIntOrNull(guardias_actual);
      if (v !== null) payload.guardias_actual = v;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'guardias_hist')) {
      const v = toIntOrNull(guardias_hist);
      if (v !== null) payload.guardias_hist = v;
    }
    if (dniProvided) payload.dni = toStrOrNull(DNI_val);
    if (fecha_matriculacion || fecha_alta) {
      payload.fecha_matriculacion = toDateOrNull(fecha_matriculacion ?? fecha_alta);
    }

    const fields = Object.keys(payload).map((k, i) => `${k}=$${i + 1}`).join(', ');
    const values = Object.values(payload);
    values.push(id);
    await client.query(
      `UPDATE alumnos SET ${fields}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    // ---------- Relaciones (solo si el form las manda) ----------
    const hasInstField = Object.prototype.hasOwnProperty.call(req.body, 'instrumentos');
    const hasGrpField  = Object.prototype.hasOwnProperty.call(req.body, 'grupos');

    if (hasInstField) {
      const arrInst = Array.isArray(instrumentos) ? instrumentos : (instrumentos ? [instrumentos] : []);
      const instIds = [...new Set(arrInst.map(v => parseInt(v, 10)).filter(Number.isFinite))];
      await client.query('DELETE FROM alumno_instrumento WHERE alumno_id = $1', [id]);
      for (const iid of instIds) {
        await client.query('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES ($1, $2)', [id, iid]);
      }
    }

    if (hasGrpField) {
      const arrGrps = Array.isArray(grupos) ? grupos : (grupos ? [grupos] : []);
      const grpIds = [...new Set(arrGrps.map(v => parseInt(v, 10)).filter(Number.isFinite))];
      await client.query('DELETE FROM alumno_grupo WHERE alumno_id = $1', [id]);
      for (const gid of grpIds) {
        await client.query('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES ($1, $2)', [id, gid]);
      }
    }

    // Cerrar la transacción ANTES de tocar password con otro pool
    await client.query('COMMIT');

    // ---------- Password fuera de la transacción (evita bloqueos) ----------
    if ((password ?? '').trim() !== '') {
      if (typeof upsertCreds === 'function') {
        await upsertCreds({
          alumnoId: id,
          email: normalizedEmail,
          registrado: registradoBool,
          plainPassword: password.trim()
        });
      } else {
        // Fallback si no tienes upsertCreds: hash directo
        const hash = await bcrypt.hash(password.trim(), 10);
        await db.query('UPDATE alumnos SET password = $1 WHERE id = $2', [hash, id]);
      }
    }

    return res.redirect(303, `/alumnos/${id}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al actualizar alumno:', err);
    return res.status(500).send('Error al actualizar alumno');
  } finally {
    client.release();
  }
});

// ───────────── Edición (form) ─────────────
router.get('/:id/editar', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const alumnoQuery = 'SELECT * FROM alumnos WHERE id = $1';
    const instrumentosQuery = 'SELECT * FROM instrumentos';
    const gruposQuery = 'SELECT * FROM grupos';
    const instrumentosAlumnoQuery = `
      SELECT instrumento_id FROM alumno_instrumento WHERE alumno_id = $1
    `;
    const gruposAlumnoQuery = `
      SELECT grupo_id FROM alumno_grupo WHERE alumno_id = $1
    `;

    const [alumnoResult, instrumentosResult, gruposResult, instAlumnoResult, grpAlumnoResult] =
      await Promise.all([
        db.query(alumnoQuery, [id]),
        db.query(instrumentosQuery),
        db.query(gruposQuery),
        db.query(instrumentosAlumnoQuery, [id]),
        db.query(gruposAlumnoQuery, [id])
      ]);

    const alumno = alumnoResult.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const instrumentosAlumno = instAlumnoResult.rows.map(r => r.instrumento_id);
    const gruposAlumno = grpAlumnoResult.rows.map(r => r.grupo_id);

    res.render('alumno', {
      alumno,
      instrumentos: instrumentosResult.rows,
      instrumentosAlumno,
      grupos: gruposResult.rows,
      gruposAlumno,
      hero: false,
      modoEditar: true
    });
  } catch (err) {
    console.error('Error cargando datos del alumno:', err);
    res.status(500).send('Error al cargar el formulario de edición');
  }
});

// ───────────── Ficha ─────────────
router.get('/nuevo/:alumnoId', async (req, res) => {
  const alumnoId = req.params.alumnoId;

  try {
    // 1. Obtener alumno
    const alumnoRes = await db.query('SELECT * FROM alumnos WHERE id = $1', [alumnoId]);
    const alumno = alumnoRes.rows[0];

    if (!alumno) return res.status(404).send('Alumno no encontrado');

    // 2. Obtener instrumentos del alumno
    const instrumentosRes = await db.query(`
      SELECT i.nombre 
      FROM instrumentos i
      JOIN alumno_instrumento ai ON ai.instrumento_id = i.id
      WHERE ai.alumno_id = $1
    `, [alumnoId]);

    const instrumentos = instrumentosRes.rows.map(i => i.nombre);

    // 3. Obtener grupos del alumno
    const gruposRes = await db.query(`
      SELECT g.nombre 
      FROM grupos g
      JOIN alumno_grupo ag ON ag.grupo_id = g.id
      WHERE ag.alumno_id = $1
    `, [alumnoId]);

    const grupos = gruposRes.rows.map(g => g.nombre);

    // 4. Obtener pagos (si aplica)
    const pagosRes = await db.query(`
      SELECT * FROM cuotas_alumno
      WHERE alumno_id = $1
      ORDER BY fecha_vencimiento DESC
    `, [alumnoId]);

    const pagos = pagosRes.rows;

    // 5. Cuotas disponibles
    const cuotasDisponiblesRes = await db.query(`SELECT * FROM cuotas ORDER BY nombre`);
    const cuotasDisponibles = cuotasDisponiblesRes.rows;

    // 6. Renderizar
    res.render('alumno', {
      alumno: {
        ...alumno,
        instrumentos: instrumentos.join(', '),
        grupos: grupos.join(', ')
      },
      pagos,
      cuotasDisponibles,
      modoEditar: false
    });

  } catch (err) {
    console.error('Error cargando datos del alumno:', err);
    res.status(500).send('Error al cargar los datos del alumno');
  }
});

// ───────────── Generar cuotas ─────────────
router.post('/generar-cuotas', async (req, res) => {
  const { alumno_id, cuota_id, fecha_inicio, fecha_fin } = req.body;

  const fechaIni = new Date(fecha_inicio);
  const fechaFin = new Date(fecha_fin);

  try {
    // Función recursiva para insertar cuotas mes a mes
    const insertarCuotasRecursivo = async (fechaActual) => {
      if (fechaActual > fechaFin) {
        return res.redirect(`/alumnos/${alumno_id}`);
      }

      const año = fechaActual.getFullYear();
      const mes = fechaActual.getMonth() + 1;
      const fechaVenc = `${año}-${mes.toString().padStart(2, '0')}-01`;

      // Comprobar si ya existe una cuota en esa fecha
      const existenteRes = await db.query(`
        SELECT 1 FROM cuotas_alumno
        WHERE alumno_id = $1 AND cuota_id = $2 AND fecha_vencimiento = $3
      `, [alumno_id, cuota_id, fechaVenc]);

      if (existenteRes.rowCount === 0) {
        await db.query(`
          INSERT INTO cuotas_alumno (alumno_id, cuota_id, fecha_vencimiento, pagado)
          VALUES ($1, $2, $3, false)
        `, [alumno_id, cuota_id, fechaVenc]);
      }

      // Siguiente mes
      const siguienteMes = new Date(fechaActual);
      siguienteMes.setMonth(fechaActual.getMonth() + 1);
      await insertarCuotasRecursivo(siguienteMes);
    };

    const inicioMes = new Date(fechaIni.getFullYear(), fechaIni.getMonth(), 1);
    await insertarCuotasRecursivo(inicioMes);

  } catch (err) {
    console.error('❌ Error generando cuotas:', err);
    res.status(500).send('Error generando cuotas');
  }
});

// ───────────── Listado ─────────────
router.get('/', async (req, res) => {
  const { estado = 'todos', grupo_id = 'todos', busqueda = '', vista } = req.query;

  // Vista: 'lista' | 'tarjetas' (por defecto tarjetas)
  const VISTA = (vista === 'lista') ? 'lista' : 'tarjetas';

  // Filtros
  const where = [];
  const params = [];

  // Estado (activo/pasivo)
  if (estado === '1') {
    where.push('COALESCE(a.activo, TRUE) IS TRUE');
  } else if (estado === '0') {
    where.push('COALESCE(a.activo, TRUE) IS FALSE');
  }

  // Grupo (EXISTS para no romper LEFT JOINs)
  const grupoIdInt = Number.isInteger(+grupo_id) ? parseInt(grupo_id, 10) : null;
  if (grupo_id !== 'todos' && grupoIdInt) {
    params.push(grupoIdInt);
    where.push(`EXISTS (
      SELECT 1
      FROM alumno_grupo agf
      WHERE agf.alumno_id = a.id AND agf.grupo_id = $${params.length}
    )`);
  }

  // Búsqueda (nombre/apellidos + instrumentos + grupos)
  if (busqueda && busqueda.trim() !== '') {
    params.push(`%${busqueda.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(
      (a.nombre || ' ' || a.apellidos) ILIKE ${p}
      OR EXISTS (
        SELECT 1
        FROM alumno_instrumento ai2
        JOIN instrumentos i2 ON i2.id = ai2.instrumento_id
        WHERE ai2.alumno_id = a.id AND i2.nombre ILIKE ${p}
      )
      OR EXISTS (
        SELECT 1
        FROM alumno_grupo ag2
        JOIN grupos g2 ON g2.id = ag2.grupo_id
        WHERE ag2.alumno_id = a.id AND g2.nombre ILIKE ${p}
      )
    )`);
  }

  // Consulta principal con agregados (instrumentos/grupos)
  const sql = `
    SELECT
      a.id,
      a.nombre,
      a.apellidos,
      COALESCE(a.activo, TRUE) AS activo,
      STRING_AGG(DISTINCT i.nombre, ', ' ORDER BY i.nombre) AS instrumentos,
      STRING_AGG(DISTINCT g.nombre, ', ' ORDER BY g.nombre) AS grupos
    FROM alumnos a
    LEFT JOIN alumno_instrumento ai ON ai.alumno_id = a.id
    LEFT JOIN instrumentos i         ON i.id = ai.instrumento_id
    LEFT JOIN alumno_grupo ag        ON ag.alumno_id = a.id
    LEFT JOIN grupos g               ON g.id = ag.grupo_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY a.id
    ORDER BY a.apellidos, a.nombre;
  `;

  try {
    const [alumnosRS, gruposRS] = await Promise.all([
      db.query(sql, params),
      db.query(`SELECT id, nombre FROM grupos
                WHERE LOWER(nombre) NOT IN ('violín i','violin i','violín ii','violin ii')
                ORDER BY nombre;`)
    ]);

    res.render('alumnos_lista', {
      title: 'Listado de músicos',
      alumnos: alumnosRS.rows,
      grupos: gruposRS.rows,
      estadoSeleccionado: estado,
      grupoId: grupo_id,
      busqueda,
      vista: VISTA
    });
  } catch (err) {
    console.error('[alumnos] GET / error:', err);
    req.session.error = 'No se pudo cargar el listado de alumnos.';
    res.redirect('/');
  }
});

// ───────────── Ficha detalle ─────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).send('ID inválido');

  try {
    const alumnoResult = await db.query('SELECT * FROM alumnos WHERE id = $1', [id]);
    const alumno = alumnoResult.rows[0];
    if (!alumno) return res.status(404).send('Alumno no encontrado');

    const [
      pagosResult,
      instrumentosResult,
      gruposResult,
      cuotasDisponiblesResult,
      cuotasAlumnoResult,
      resumenResult
    ] = await Promise.all([
      db.query(`
        SELECT 
          p.id AS pago_id,
          p.fecha_pago,
          p.importe AS importe_pago,
          p.medio_pago,
          p.referencia,
          p.observaciones,
          c.nombre AS cuota_nombre,
          pca.importe_aplicado
        FROM pagos p
        JOIN pago_cuota_alumno pca ON p.id = pca.pago_id
        JOIN cuotas_alumno ca ON pca.cuota_alumno_id = ca.id
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE p.alumno_id = $1
        ORDER BY p.fecha_pago DESC
      `, [id]),
      db.query(`
        SELECT i.nombre
        FROM instrumentos i
        JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = $1
      `, [id]),
      db.query(`
        SELECT g.nombre
        FROM grupos g
        JOIN alumno_grupo ag ON ag.grupo_id = g.id
        WHERE ag.alumno_id = $1
      `, [id]),
      db.query('SELECT * FROM cuotas ORDER BY nombre'),
      db.query(`
        SELECT ca.*, c.nombre AS nombre_cuota, c.precio
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
        ORDER BY ca.fecha_vencimiento ASC
      `, [id]),
      db.query(`
        SELECT
          COALESCE(SUM(c.precio), 0) AS total_cuotas,
          COALESCE((
            SELECT SUM(pca.importe_aplicado)
            FROM cuotas_alumno ca2
            JOIN pago_cuota_alumno pca ON pca.cuota_alumno_id = ca2.id
            WHERE ca2.alumno_id = $1
          ), 0) AS total_pagado
        FROM cuotas_alumno ca
        JOIN cuotas c ON ca.cuota_id = c.id
        WHERE ca.alumno_id = $1
      `, [id])
    ]);

    const instrumentos = instrumentosResult.rows.map(i => i.nombre).join(', ');
    const grupos = gruposResult.rows.map(g => g.nombre).join(', ');
    const resumen = resumenResult.rows[0] || { total_cuotas: 0, total_pagado: 0 };
    resumen.total_cuotas = Number(resumen.total_cuotas || 0);
    resumen.total_pagado = Number(resumen.total_pagado || 0);
    resumen.total_pendiente = resumen.total_cuotas - resumen.total_pagado;

    res.render('alumno', {
      alumno: { ...alumno, instrumentos, grupos },
      pagos: pagosResult.rows,
      cuotasDisponibles: cuotasDisponiblesResult.rows,
      cuotasAlumno: cuotasAlumnoResult.rows,
      resumenDeuda: resumen,
      modoEditar: false
    });

  } catch (err) {
    console.error('Error mostrando detalle del alumno:', err);
    res.status(500).send('Error interno');
  }
});

// ───────────── Eliminar ─────────────
router.post('/:id/eliminar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await db.connect();
  try {
    const { rows } = await client.query('SELECT foto FROM alumnos WHERE id = $1', [id]);
    const foto = rows[0]?.foto;

    await client.query('BEGIN');
    await client.query('DELETE FROM alumno_grupo WHERE alumno_id = $1', [id]);
    await client.query('DELETE FROM alumno_instrumento WHERE alumno_id = $1', [id]);
    await client.query('DELETE FROM cuotas_alumno WHERE alumno_id = $1', [id]);
    await client.query('DELETE FROM alumnos WHERE id = $1', [id]);
    await client.query('COMMIT');

    await safeUnlinkFromUploads(foto);
    res.redirect('/alumnos');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Error al eliminar alumno:', err);
    res.status(500).send('Error al eliminar alumno');
  } finally {
    client.release();
  }
});


module.exports = router;

