const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });
const { toISODate } = require('../utils/fechas');
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
router.get('/nuevo', async (req, res) => {
  try {
    const instrumentos = (await db.query('SELECT * FROM instrumentos')).rows;
    const grupos = (await db.query('SELECT * FROM grupos')).rows;

    res.render('alumno_form', {
      alumno: null,
      instrumentos,
      instrumentosAlumno: [],
      grupos,
      gruposAlumno: [],
      hero: false
    });
  } catch (err) {
    res.status(500).send('Error al cargar instrumentos o grupos');
  }
});
router.post('/', upload.single('foto'), async (req, res) => {
  const {
    nombre, apellidos, tutor, direccion, codigo_postal,
    municipio, provincia, telefono, email,
    fecha_nacimiento, dni, centro, profesor_centro,
    instrumentos, grupos
  } = req.body;
  const fechaNacISO = toISODate(fecha_nacimiento);
  const foto = req.file ? req.file.filename : null;
  const activo = req.body.activo === '1' ? true : false;
  const fechaMat = new Date().toISOString().split('T')[0];

  const sqlInsert = `
    INSERT INTO alumnos (
      nombre, apellidos, tutor, direccion, codigo_postal,
      municipio, provincia, telefono, email, fecha_nacimiento,
      dni, centro, profesor_centro, foto, activo, fecha_matriculacion
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id
  `;
  const paramsInsert = [
    nombre, apellidos, tutor, direccion, codigo_postal,
    municipio, provincia, telefono, email,
    fechaNacISO, dni, centro, profesor_centro,
    foto, activo, fechaMat
  ];

  try {
    const result = await db.query(sqlInsert, paramsInsert);
    const newId = result.rows[0].id;

    const instArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    for (let iid of instArray) {
      await db.query('INSERT INTO alumno_instrumento (alumno_id, instrumento_id) VALUES ($1, $2)', [newId, iid]);
    }

    const grpArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
    for (let gid of grpArray) {
      await db.query('INSERT INTO alumno_grupo (alumno_id, grupo_id) VALUES ($1, $2)', [newId, gid]);
    }
    // ---- NUEVO: credenciales app (opcional) ----
    const registradoFlag = String(req.body.registrado || '0') === '1';
    const plainPassword  = req.body.password || '';
    await upsertCreds({
      alumnoId: newId,
      email: (req.body.email || '').trim(),
      registrado: registradoFlag,
      plainPassword
    });

    res.redirect(`/alumnos/${newId}`);
  } catch (err) {
    console.error('Error al crear alumno:', err);
    res.status(500).send('Error al guardar alumno');
  }
});
// Centro de ayuda (en Configuración)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_alumnos', { title: 'Ayuda · Alumnos', hero: false });
});
// routes/alumnos.js (o donde tengas las rutas de alumnos)
router.get(['/alumnos/ayuda', '/musicos/ayuda'], (_req, res) => {
  res.render('ayuda_musicos', { title: 'Ayuda · Músicos', hero: false });
});
router.put('/:id', upload.single('foto'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

  // Helpers de saneo
  const toStrOrNull = (v) =>
    v === '' || v === undefined || v === null ? null : String(v).trim();

  const toIntOrNull = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };

  const toDateOrNull = (v) => {
    if (!v || v === '') return null;
    const s = String(v);
    // admite 'YYYY-MM-DD' o ISO con 'T'
    return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
  };

  const {
    nombre,
    apellidos,
    tutor,
    direccion,
    codigo_postal,
    municipio,
    provincia,
    telefono,
    email,
    fecha_nacimiento,
    dni,
    centro,
    profesor_centro,
    instrumentos,
    grupos,
    fotoActual
  } = req.body;

  const foto = req.file ? req.file.filename : (fotoActual || null);
  const activo = req.body.activo === '1' || req.body.activo === true ? 1 : 0;
  const fechaBaja = activo === 0 ? new Date().toISOString().slice(0, 10) : null;

  // Payload saneado
  const payload = {
    nombre:            toStrOrNull(nombre),
    apellidos:         toStrOrNull(apellidos),
    tutor:             toStrOrNull(tutor),
    direccion:         toStrOrNull(direccion),
    codigo_postal:     toIntOrNull(codigo_postal),       // <- evita '' -> 0 (error)
    municipio:         toStrOrNull(municipio),
    provincia:         toStrOrNull(provincia),
    telefono:          toStrOrNull(telefono),
    email:             toStrOrNull(email),
    fecha_nacimiento:  toDateOrNull(fecha_nacimiento),
    dni:               toStrOrNull(dni),
    centro:            toStrOrNull(centro),
    profesor_centro:   toStrOrNull(profesor_centro),
    foto:              toStrOrNull(foto),
    activo,                                             // 1/0
    fecha_baja:        toDateOrNull(fechaBaja)
  };

  // Normaliza arrays (evita ids vacíos)
  const arrInst = Array.isArray(instrumentos) ? instrumentos : (instrumentos ? [instrumentos] : []);
  const cleanInst = arrInst.map(toIntOrNull).filter(n => n !== null);

  const arrGrp = Array.isArray(grupos) ? grupos : (grupos ? [grupos] : []);
  const cleanGrps = arrGrp.map(toIntOrNull).filter(n => n !== null);

  const sql = `
    UPDATE alumnos
       SET nombre            = $2,
           apellidos         = $3,
           tutor             = $4,
           direccion         = $5,
           codigo_postal     = $6,   -- INTEGER o NULL
           municipio         = $7,
           provincia         = $8,
           telefono          = $9,
           email             = $10,
           fecha_nacimiento  = $11,  -- DATE o NULL
           dni               = $12,
           centro            = $13,
           profesor_centro   = $14,
           foto              = $15,
           activo            = $16,  -- 1/0 (boolean-like)
           fecha_baja        = $17,  -- DATE o NULL
           updated_at        = NOW()
     WHERE id = $1
  `;

  const params = [
    id,
    payload.nombre,
    payload.apellidos,
    payload.tutor,
    payload.direccion,
    payload.codigo_postal,     // <- ya saneado (null o int)
    payload.municipio,
    payload.provincia,
    payload.telefono,
    payload.email,
    payload.fecha_nacimiento,  // <- 'YYYY-MM-DD' o null
    payload.dni,
    payload.centro,
    payload.profesor_centro,
    payload.foto,
    payload.activo,
    payload.fecha_baja
  ];

  try {
    await db.query('BEGIN');
    // ---- NUEVO: credenciales app (opcional) ----
const registradoFlag = String(req.body.registrado || (alumno?.registrado ? '1' : '0')) === '1';
const plainPassword  = req.body.password || '';
await upsertCreds({
  alumnoId: id,
  email: (req.body.email || '').trim(),
  registrado: registradoFlag,
  plainPassword
});

    // Update alumno
    await db.query(sql, params);

    // Relaciones: instrumentos
    await db.query('DELETE FROM alumno_instrumento WHERE alumno_id = $1', [id]);
    if (cleanInst.length) {
      const text = `
        INSERT INTO alumno_instrumento (alumno_id, instrumento_id)
        SELECT $1, x FROM UNNEST($2::int[]) AS t(x)
      `;
      await db.query(text, [id, cleanInst]);
    }

    // Relaciones: grupos
    await db.query('DELETE FROM alumno_grupo WHERE alumno_id = $1', [id]);
    if (cleanGrps.length) {
      const text = `
        INSERT INTO alumno_grupo (alumno_id, grupo_id)
        SELECT $1, x FROM UNNEST($2::int[]) AS t(x)
      `;
      await db.query(text, [id, cleanGrps]);
    }

    await db.query('COMMIT');
    res.redirect(`/alumnos/${id}`);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error al actualizar alumno:', err);
    res.status(500).send('Error al actualizar alumno');
  }
});
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

    res.render('alumno_form', {
      alumno,
      instrumentos: instrumentosResult.rows,
      instrumentosAlumno,
      grupos: gruposResult.rows,
      gruposAlumno,
      hero: false
    });
  } catch (err) {
    console.error('Error cargando datos del alumno:', err);
    res.status(500).send('Error al cargar el formulario de edición');
  }
});
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

    // 5. Obtener cuotas disponibles
    const cuotasDisponiblesRes = await db.query(`SELECT * FROM cuotas ORDER BY nombre`);
    const cuotasDisponibles = cuotasDisponiblesRes.rows;

    // 6. Renderizar
    res.render('alumnos_ficha', {
      alumno: {
        ...alumno,
        instrumentos: instrumentos.join(', '),
        grupos: grupos.join(', ')
      },
      pagos,
      cuotasDisponibles
    });

  } catch (err) {
    console.error('Error cargando datos del alumno:', err);
    res.status(500).send('Error al cargar los datos del alumno');
  }
});
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
// LISTAR ALUMNOS (tarjetas/lista) -------------------------------------------
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
      -- agregados ordenados y únicos
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
      db.query('SELECT id, nombre FROM grupos ORDER BY nombre;')
    ]);

    res.render('alumnos_lista', {
      title: 'Listado de músicos',
      alumnos: alumnosRS.rows,
      grupos: gruposRS.rows,
      estadoSeleccionado: estado,
      grupoId: grupo_id,
      busqueda,
      vista: VISTA    // <- la vista que usará el switch en la plantilla
    });
  } catch (err) {
    console.error('[alumnos] GET / error:', err);
    req.session.error = 'No se pudo cargar el listado de alumnos.';
    res.redirect('/');
  }
});
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
        JOIN alumno_grupo ag ON g.id = ag.grupo_id
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
    resumen.total_pendiente = resumen.total_cuotas - resumen.total_pagado;

    res.render('alumnos_ficha', {
      alumno: { ...alumno, instrumentos, grupos },
      pagos: pagosResult.rows,
      cuotasDisponibles: cuotasDisponiblesResult.rows,
      cuotasAlumno: cuotasAlumnoResult.rows,
      resumenDeuda: resumen
    });

  } catch (err) {
    console.error('Error mostrando detalle del alumno:', err);
    res.status(500).send('Error interno');
  }
});
router.post('/:id/eliminar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // Obtener nombre de archivo de foto
    const result = await db.query('SELECT foto FROM alumnos WHERE id = $1', [id]);
    const foto = result.rows[0]?.foto;

    // Borrar relaciones
    await db.query('DELETE FROM alumno_grupo WHERE alumno_id = $1', [id]);
    await db.query('DELETE FROM alumno_instrumento WHERE alumno_id = $1', [id]);
    await db.query('DELETE FROM cuotas_alumno WHERE alumno_id = $1', [id]);
    // Borrar alumno
    await db.query('DELETE FROM alumnos WHERE id = $1', [id]);

    // Borrar foto si existe
    if (foto) {
      const path = `./uploads/${foto}`;
      if (fs.existsSync(path)) fs.unlinkSync(path);
    }

    res.redirect('/alumnos');
  } catch (err) {
    console.error('❌ Error al eliminar alumno:', err);
    res.status(500).send('Error al eliminar alumno');
  }
});

module.exports = router;
