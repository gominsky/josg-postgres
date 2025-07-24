const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt   = require('bcrypt');
const saltRounds = 10;

// Conexión a la base de datos
const db = new sqlite3.Database(path.resolve(__dirname, 'josg.db'), (err) => {
  if (err) console.error('Error al conectar con la base de datos', err);
  else console.log('Base de datos SQLite conectada');
});

// Crear tablas
//Usuarios de la aplicación
db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT    NOT NULL,
      apellidos  TEXT    NOT NULL,
      email      TEXT    UNIQUE NOT NULL,
      password   TEXT    NOT NULL,
      rol        TEXT    CHECK(rol IN ('admin','docente','usuario')) NOT NULL DEFAULT 'usuario',
      creado_en  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, err => {
    if (err) throw err;

    // 2) Sembrar un admin por defecto si no existe ninguno
    db.get(`SELECT COUNT(*) AS cnt FROM usuarios WHERE rol = 'admin'`, (err, row) => {
      if (err) {
        console.error('Error comprobando admin:', err);
        return;
      }

      if (row.cnt === 0) {
        const defaultAdmin = {
          nombre:    'Admin',
          apellidos: 'Default',
          email:     'admin@josg.com',
          password:  'admin1234' 
        };

        bcrypt.hash(defaultAdmin.password, saltRounds, (err, hash) => {
          if (err) {
            console.error('Error al hashear contraseña admin:', err);
            return;
          }

          db.run(
            `INSERT INTO usuarios (nombre, apellidos, email, password, rol)
             VALUES (?, ?, ?, ?, 'admin')`,
            [ defaultAdmin.nombre,
              defaultAdmin.apellidos,
              defaultAdmin.email,
              hash
            ],
            err => {
              if (err) {
                console.error('Error al crear usuario admin por defecto:', err);
              } else {
                console.log('Usuario admin por defecto creado: admin@josg.com');
              }
            }
          );
        });
      }
    });
});  

//Alumnos
db.run(`
  CREATE TABLE IF NOT EXISTS alumnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    activo INTEGER DEFAULT 1,
    password TEXT DEFAULT NULL,
    registrado INTEGER DEFAULT 0,
    guardias_actual INTEGER DEFAULT 0,
    guardias_hist INTEGER DEFAULT 0,
    fecha_matriculacion TEXT,
    fecha_baja TEXT
    )
`);
//Profesores
db.run(`
  CREATE TABLE IF NOT EXISTS profesores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  apellidos TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  fecha_nacimiento TEXT,
  telefono TEXT,
  direccion TEXT,
  especialidad TEXT,
  foto TEXT,
  activo INTEGER DEFAULT 1
  )
`);
//Instrumentos
db.run(`
  CREATE TABLE IF NOT EXISTS instrumentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    familia TEXT CHECK(familia IN ('Cuerda','Percusión','Viento madera','Viento metal', 'Otra')) DEFAULT 'Otra'
  )
`);
//Relación alumno-instrumento
db.run(`
  CREATE TABLE  IF NOT EXISTS alumno_instrumento (
    alumno_id INTEGER,
    instrumento_id INTEGER,
    PRIMARY KEY (alumno_id, instrumento_id),
    FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
    FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
   )
    `);
//Relación profesor-instrumento (muchos a muchos)
db.run(`
  CREATE TABLE IF NOT EXISTS profesor_instrumento (
    profesor_id INTEGER,
    instrumento_id INTEGER,
    PRIMARY KEY (profesor_id, instrumento_id),
    FOREIGN KEY (profesor_id) REFERENCES profesores(id),
    FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
  )
`);
//Grupos
db.run(`
  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT
  )
`);
//Relación alumno-grupo
db.run(`
  CREATE TABLE  IF NOT EXISTS alumno_grupo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alumno_id INTEGER NOT NULL,
    grupo_id INTEGER NOT NULL,
    FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
    FOREIGN KEY (grupo_id) REFERENCES grupos(id)
  )
    `);
//Relación profesor-grupo (muchos a muchos)
db.run(`
  CREATE TABLE IF NOT EXISTS profesor_grupo (
    profesor_id INTEGER,
    grupo_id INTEGER,
    PRIMARY KEY (profesor_id, grupo_id),
    FOREIGN KEY (profesor_id) REFERENCES profesores(id),
    FOREIGN KEY (grupo_id) REFERENCES grupos(id)
  )
`);
//Eventos
db.run(`  
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  fecha_inicio TEXT NOT NULL,
  fecha_fin TEXT NOT NULL,
  hora_inicio TEXT,
  hora_fin TEXT,
  grupo_id INTEGER NOT NULL,
  token TEXT,
  activo INTEGER DEFAULT 0,
  FOREIGN KEY (grupo_id) REFERENCES grupos(id)
 )
`);
//Control de asistencias
db.run(` 
  CREATE TABLE IF NOT EXISTS asistencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL, 
    alumno_id INTEGER NOT NULL,
    fecha TEXT,
    hora TEXT,
    ubicacion TEXT,
    observaciones TEXT,
    tipo TEXT DEFAULT 'qr',
    FOREIGN KEY (evento_id) REFERENCES eventos(id),
    FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
)
  `);
//Guardias
 db.run(` 
  CREATE TABLE IF NOT EXISTS guardias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL, 
    fecha TEXT NOT NULL,
    alumno_id_1 INTEGER NOT NULL,
    alumno_id_2 INTEGER NOT NULL,
    notas TEXT,
    curso TEXT, -- por ejemplo "2025/2026"
    FOREIGN KEY (evento_id) REFERENCES eventos(id),
    FOREIGN KEY (alumno_id_1) REFERENCES alumnos(id),
    FOREIGN KEY (alumno_id_2) REFERENCES alumnos(id)
)
  `);
//Cuotas
db.run(`  
  CREATE TABLE  IF NOT EXISTS cuotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    descripcion TEXT,
    tipo_id  INTEGER NOT NULL,
    FOREIGN KEY (tipo_id) REFERENCES tipos_cuota(id)
)
  `);
//Relación cuotas-alumno
db.run(`
  CREATE TABLE IF NOT EXISTS cuotas_alumno (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alumno_id INTEGER NOT NULL,
    cuota_id INTEGER NOT NULL,
    pagado INTEGER DEFAULT 0,      -- 0: no pagado, 1: pagado
    fecha_vencimiento TEXT,
    fecha_pago TEXT,
    FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
    FOREIGN KEY (cuota_id) REFERENCES cuotas(id)
  )
`);
// Pagos
db.run(` 
  CREATE TABLE IF NOT EXISTS pagos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alumno_id INTEGER NOT NULL,
    importe REAL NOT NULL,
    fecha_pago TEXT NOT NULL,
    medio_pago TEXT,           -- efectivo, transferencia, etc.
    referencia TEXT,           -- recibo, comprobante bancario, etc.
    observaciones TEXT,
    FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
  )
`);
//Realación pago-cuota-alumno
db.run(`
CREATE TABLE IF NOT EXISTS pago_cuota_alumno (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pago_id INTEGER NOT NULL,
  cuota_alumno_id INTEGER NOT NULL,
  importe_aplicado REAL NOT NULL,
  FOREIGN KEY (pago_id) REFERENCES pagos(id),
  FOREIGN KEY (cuota_alumno_id) REFERENCES cuotas_alumno(id)
)
`);
//Tipos de cuota
db.run(`
  CREATE TABLE IF NOT EXISTS tipos_cuota (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL UNIQUE
  )
`);
db.run(`
  CREATE TABLE  IF NOT EXISTS informes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    informe TEXT NOT NULL,
    grupo_id INTEGER,
    instrumento_id INTEGER,
    profesor_id INTEGER,
    fecha TEXT DEFAULT CURRENT_DATE,
    observaciones TEXT,
    FOREIGN KEY (grupo_id) REFERENCES grupos(id),
    FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id),
    FOREIGN KEY (profesor_id) REFERENCES profesores(id)
  )
    `);
//tablas para campos dinámicos
db.run(`
CREATE TABLE IF NOT EXISTS informe_campos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  informe_id INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,
  obligatorio INTEGER DEFAULT 0,
  FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS informe_resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  informe_id INTEGER NOT NULL,
  alumno_id INTEGER,
  campo_id INTEGER NOT NULL,
  valor TEXT,
  fila INTEGER,
  FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE,
  FOREIGN KEY (alumno_id) REFERENCES alumnos(id) ON DELETE CASCADE,
  FOREIGN KEY (campo_id) REFERENCES informe_campos(id) ON DELETE CASCADE
)
`);

module.exports = db;