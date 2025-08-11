const db = require('./db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

async function init() {
  try {
    // Crear tablas
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rol TEXT CHECK(rol IN ('admin','docente','usuario')) NOT NULL DEFAULT 'usuario',
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumnos (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        apellidos TEXT,
        tutor TEXT,
        direccion TEXT,
        codigo_postal INTEGER,
        municipio TEXT,
        provincia TEXT,
        telefono TEXT,
        email TEXT,
        fecha_nacimiento TEXT,
        DNI TEXT,
        centro TEXT,
        profesor_centro TEXT,
        repertorio_id INTEGER,
        foto TEXT,
        activo BOOLEAN DEFAULT TRUE,
        password TEXT DEFAULT NULL,
        registrado BOOLEAN DEFAULT FALSE,
        guardias_actual INTEGER DEFAULT 0,
        guardias_hist INTEGER DEFAULT 0,
        fecha_matriculacion TEXT,
        fecha_baja TEXT
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesores (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        fecha_nacimiento TEXT,
        telefono TEXT,
        direccion TEXT,
        especialidad TEXT,
        foto TEXT,
        activo BOOLEAN DEFAULT TRUE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS instrumentos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        familia TEXT CHECK(familia IN ('Cuerda','Percusión','Viento madera','Viento metal', 'Otra')) DEFAULT 'Otra'
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumno_instrumento (
        alumno_id INTEGER,
        instrumento_id INTEGER,
        PRIMARY KEY (alumno_id, instrumento_id),
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesor_instrumento (
        profesor_id INTEGER,
        instrumento_id INTEGER,
        PRIMARY KEY (profesor_id, instrumento_id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS grupos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        descripcion TEXT
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumno_grupo (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        grupo_id INTEGER NOT NULL,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesor_grupo (
        profesor_id INTEGER,
        grupo_id INTEGER,
        PRIMARY KEY (profesor_id, grupo_id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id),
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS eventos (
        id SERIAL PRIMARY KEY,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha_inicio TEXT NOT NULL,
        fecha_fin TEXT NOT NULL,
        hora_inicio TEXT,
        hora_fin TEXT,
        observaciones TEXT,
        grupo_id INTEGER NOT NULL,
        token TEXT,
        activo BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS asistencias (
        id SERIAL PRIMARY KEY,
        evento_id INTEGER NOT NULL,
        alumno_id INTEGER NOT NULL,
        fecha TEXT,
        hora TEXT,
        ubicacion TEXT,
        observaciones TEXT,
        tipo TEXT DEFAULT 'qr',
        FOREIGN KEY (evento_id) REFERENCES eventos(id),
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        CONSTRAINT asistencias_alumno_evento_uniq UNIQUE (alumno_id, evento_id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS guardias (
        id SERIAL PRIMARY KEY,
        evento_id INTEGER NOT NULL,
        fecha TEXT NOT NULL,
        alumno_id_1 INTEGER NOT NULL,
        alumno_id_2 INTEGER NOT NULL,
        notas TEXT,
        curso TEXT,
        FOREIGN KEY (evento_id) REFERENCES eventos(id),
        FOREIGN KEY (alumno_id_1) REFERENCES alumnos(id),
        FOREIGN KEY (alumno_id_2) REFERENCES alumnos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS tipos_cuota (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL UNIQUE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS cuotas (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        precio NUMERIC NOT NULL,
        descripcion TEXT,
        tipo_id INTEGER NOT NULL,
        FOREIGN KEY (tipo_id) REFERENCES tipos_cuota(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS cuotas_alumno (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        cuota_id INTEGER NOT NULL,
        pagado BOOLEAN DEFAULT FALSE,
        fecha_vencimiento TEXT,
        fecha_pago TEXT,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (cuota_id) REFERENCES cuotas(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS pagos (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        importe NUMERIC NOT NULL,
        fecha_pago TEXT NOT NULL,
        medio_pago TEXT,
        referencia TEXT,
        observaciones TEXT,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS pago_cuota_alumno (
        id SERIAL PRIMARY KEY,
        pago_id INTEGER NOT NULL,
        cuota_alumno_id INTEGER NOT NULL,
        importe_aplicado NUMERIC NOT NULL,
        FOREIGN KEY (pago_id) REFERENCES pagos(id),
        FOREIGN KEY (cuota_alumno_id) REFERENCES cuotas_alumno(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informes (
        id SERIAL PRIMARY KEY,
        informe TEXT NOT NULL,
        grupo_id INTEGER,
        instrumento_id INTEGER,
        profesor_id INTEGER,
        fecha TEXT DEFAULT CURRENT_DATE,
        observaciones TEXT,
        FOREIGN KEY (grupo_id) REFERENCES grupos(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informe_campos (
        id SERIAL PRIMARY KEY,
        informe_id INTEGER NOT NULL,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        obligatorio BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informe_resultados (
        id SERIAL PRIMARY KEY,
        informe_id INTEGER NOT NULL,
        alumno_id INTEGER,
        campo_id INTEGER NOT NULL,
        valor TEXT,
        fila INTEGER,
        FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id) ON DELETE CASCADE,
        FOREIGN KEY (campo_id) REFERENCES informe_campos(id) ON DELETE CASCADE
      );
    `);

    // Sembrar usuario admin si no existe
    const result = await db.query("SELECT COUNT(*) FROM usuarios WHERE rol = 'admin'");
    if (parseInt(result.rows[0].count) === 0) {
      const defaultAdmin = {
        nombre: 'Admin',
        apellidos: 'Default',
        email: 'admin@josg.org',
        password: 'A.12qwerty'
      };
      const hash = await bcrypt.hash(defaultAdmin.password, saltRounds);
      await db.query(
        "INSERT INTO usuarios (nombre, apellidos, email, password, rol) VALUES ($1, $2, $3, $4, 'admin')",
        [defaultAdmin.nombre, defaultAdmin.apellidos, defaultAdmin.email, hash]
      );
      console.log("Usuario admin por defecto creado.");
    }
  // 🏛️ GRUPOS BASE
  const grupos = [
    'OEG',
    'JOSG',
    'Aspirantes OEG',
    'Aspirantes JOSG',
    'Música de Cámara'
  ];

  const resGrupos = await db.query('SELECT COUNT(*) FROM grupos');
  if (parseInt(resGrupos.rows[0].count) === 0) {
    for (const nombre of grupos) {
      await db.query('INSERT INTO grupos (nombre) VALUES ($1)', [nombre]);
    }
    console.log("Grupos base insertados.");
  }

  // 💳 TIPOS DE CUOTA
  const tiposCuota = ['Mensual', 'Semanal', 'Puntual', 'Otra'];

  const resTipos = await db.query('SELECT COUNT(*) FROM tipos_cuota');
  if (parseInt(resTipos.rows[0].count) === 0) {
    for (const tipo of tiposCuota) {
      await db.query('INSERT INTO tipos_cuota (tipo) VALUES ($1)', [tipo]);
    }
    console.log("Tipos de cuota insertados.");
  }

  // 💰 CUOTAS BASE
  const cuotasBase = [
    { nombre: 'Mensualidad', precio: 50, tipo: 'Mensual' },
    { nombre: 'Extraordinaria', precio: 100, tipo: 'Puntual' },
    { nombre: 'Matrícula', precio: 100, tipo: 'Puntual' }
  ];

  const resCuotas = await db.query('SELECT COUNT(*) FROM cuotas');
  if (parseInt(resCuotas.rows[0].count) === 0) {
    for (const cuota of cuotasBase) {
      const tipoId = await db.query('SELECT id FROM tipos_cuota WHERE tipo = $1', [cuota.tipo]);
      if (tipoId.rows.length > 0) {
        await db.query(
          'INSERT INTO cuotas (nombre, precio, tipo_id) VALUES ($1, $2, $3)',
          [cuota.nombre, cuota.precio, tipoId.rows[0].id]
        );
      }
    }
    console.log("Cuotas base insertadas.");
  }

  // 🎻 INSTRUMENTOS BASE
  const instrumentos = [
    { nombre: 'Violín', familia: 'Cuerda' },
    { nombre: 'Viola', familia: 'Cuerda' },
    { nombre: 'Violonchelo', familia: 'Cuerda' },
    { nombre: 'Contrabajo', familia: 'Cuerda' },
    { nombre: 'Flauta', familia: 'Viento madera' },
    { nombre: 'Oboe', familia: 'Viento madera' },
    { nombre: 'Clarinete', familia: 'Viento madera' },
    { nombre: 'Fagot', familia: 'Viento madera' },
    { nombre: 'Trompeta', familia: 'Viento metal' },
    { nombre: 'Trompa', familia: 'Viento metal' },
    { nombre: 'Trombón', familia: 'Viento metal' },
    { nombre: 'Tuba', familia: 'Viento metal' },
    { nombre: 'Percusión', familia: 'Percusión' },
    { nombre: 'Batería', familia: 'Percusión' }
  ];

  const resInstru = await db.query('SELECT COUNT(*) FROM instrumentos');
  if (parseInt(resInstru.rows[0].count) === 0) {
    for (const instr of instrumentos) {
      await db.query(
        'INSERT INTO instrumentos (nombre, familia) VALUES ($1, $2)',
        [instr.nombre, instr.familia]
      );
    }
    console.log("Instrumentos base insertados.");
  }
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err);
  }
}
module.exports = init;