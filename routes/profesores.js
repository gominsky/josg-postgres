const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const path = require('path');

// Configuración de multer
const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// GET: Nuevo profesor
router.get('/nuevo', (req, res) => {
  db.all('SELECT * FROM instrumentos', (err, instrumentos) => {
    if (err) return res.status(500).send('Error al cargar instrumentos');

    db.all('SELECT * FROM grupos', (err2, grupos) => {
      if (err2) return res.status(500).send('Error al cargar grupos');

      res.render('profesor_form', {
        profesor: null,
        instrumentos,
        instrumentosProfesor: [],
        grupos,
        gruposProfesor: [],
        hero: false
      });
    });
  });
});

// POST: Crear profesor
const bcrypt = require('bcrypt'); // Asegúrate de tenerlo instalado
router.post('/', upload.single('foto'), (req, res) => {
  const {
    nombre, apellidos, email, telefono,
    direccion, fecha_nacimiento, especialidad,
    instrumentos, grupos
  } = req.body;
  const activo = req.body.activo === '1' ? 1 : 0;
  const foto = req.file ? req.file.filename : null;


  const query = `
    INSERT INTO profesores (nombre, apellidos, email, telefono, direccion, fecha_nacimiento, especialidad, foto, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [nombre, apellidos, email, telefono, direccion, fecha_nacimiento, especialidad, foto, activo];

  db.run(query, params, function (err) {
    if (err) {
      if (err.code === 'SQLITE_CONSTRAINT') {
        return renderFormularioConError('El correo electrónico ya está registrado.');
      }
      return res.status(500).send('Error al registrar el profesor');
    }

    const profesorId = this.lastID;

    // Insertar relaciones
    const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
    const gruposArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];

    const stmtInst = db.prepare('INSERT INTO profesor_instrumento (profesor_id, instrumento_id) VALUES (?, ?)');
    instrumentosArray.forEach(instId => {
      if (instId) stmtInst.run(profesorId, instId);
    });
    stmtInst.finalize();

    const stmtGrupos = db.prepare('INSERT INTO profesor_grupo (profesor_id, grupo_id) VALUES (?, ?)');
    gruposArray.forEach(grupoId => {
      if (grupoId) stmtGrupos.run(profesorId, grupoId);
    });
    stmtGrupos.finalize();

    res.redirect('/profesores');
  });

  function renderFormularioConError(mensaje) {
    db.all('SELECT * FROM grupos', (err1, gruposAll) => {
      db.all('SELECT * FROM instrumentos', (err2, instrumentosAll) => {
        res.render('profesor_form', {
          error: mensaje,
          profesor: {
            nombre, apellidos, email, telefono,
            direccion, fecha_nacimiento, especialidad,
            activo
          },
          grupos: gruposAll,
          instrumentos: instrumentosAll,
          gruposProfesor: Array.isArray(grupos) ? grupos.map(Number) : grupos ? [Number(grupos)] : [],
          instrumentosProfesor: Array.isArray(instrumentos) ? instrumentos.map(Number) : instrumentos ? [Number(instrumentos)] : []
        });
      });
    });
  }
});

// GET: Editar profesor
router.get('/:id/editar', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM profesores WHERE id = ?', [id], (err, profesor) => {
    if (err || !profesor) return res.status(404).send('Profesor no encontrado');

    db.all('SELECT * FROM instrumentos', (err2, instrumentos) => {
      if (err2) return res.status(500).send('Error al cargar instrumentos');

      db.all('SELECT instrumento_id FROM profesor_instrumento WHERE profesor_id = ?', [id], (err3, filasInst) => {
        if (err3) return res.status(500).send('Error al obtener instrumentos');

        const instrumentosProfesor = filasInst.map(f => f.instrumento_id);

        db.all('SELECT * FROM grupos', (err4, grupos) => {
          if (err4) return res.status(500).send('Error al cargar grupos');

          db.all('SELECT grupo_id FROM profesor_grupo WHERE profesor_id = ?', [id], (err5, filasGrupos) => {
            if (err5) return res.status(500).send('Error al obtener grupos');

            const gruposProfesor = filasGrupos.map(f => f.grupo_id);

            res.render('profesor_form', {
              profesor,
              instrumentos,
              instrumentosProfesor,
              grupos,
              gruposProfesor,
              hero: false
            });
          });
        });
      });
    });
  });
});

// PUT: Actualizar profesor
router.put('/:id', upload.single('foto'), (req, res) => {
  const id = req.params.id;
  const {
    nombre,
    apellidos,
    email,
    telefono,
    direccion,
    fecha_nacimiento,
    especialidad,
    instrumentos,
    grupos
  } = req.body;
  const activo = req.body.activo === '1' ? 1 : 0;
  const foto = req.file ? req.file.filename : null;

  // Validación mínima
  if (!nombre || !apellidos || !email) {
    return recargarFormulario('Nombre, apellidos y correo electrónico son obligatorios.');
  }

  // Construcción dinámica de query y parámetros
  const campos = [
    'nombre = ?',
    'apellidos = ?',
    'email = ?',
    'telefono = ?',
    'direccion = ?',
    'fecha_nacimiento = ?',
    'especialidad = ?',
    'activo = ?'
  ];
  const params = [
    nombre, apellidos, email, telefono, direccion,
    fecha_nacimiento, especialidad, activo
  ];

  if (foto) {
    campos.push('foto = ?');
    params.push(foto);
  }
  const query = `UPDATE profesores SET ${campos.join(', ')} WHERE id = ?`;
  params.push(id);

  db.run(query, params, err => {
    if (err && err.code === 'SQLITE_CONSTRAINT') {
      return recargarFormulario('El correo electrónico ya está registrado.');
    }
    if (err) return res.status(500).send('Error al actualizar profesor');

    // Limpiar relaciones y volver a insertar
    db.run('DELETE FROM profesor_instrumento WHERE profesor_id = ?', [id], err2 => {
      if (err2) return res.status(500).send('Error al limpiar instrumentos');

      const instrumentosArray = Array.isArray(instrumentos) ? instrumentos : instrumentos ? [instrumentos] : [];
      const stmtInst = db.prepare('INSERT INTO profesor_instrumento (profesor_id, instrumento_id) VALUES (?, ?)');
      instrumentosArray.forEach(instId => {
        if (instId) stmtInst.run(id, instId);
      });

      stmtInst.finalize(() => {
        db.run('DELETE FROM profesor_grupo WHERE profesor_id = ?', [id], () => {
          const gruposArray = Array.isArray(grupos) ? grupos : grupos ? [grupos] : [];
          const stmtGrupos = db.prepare('INSERT INTO profesor_grupo (profesor_id, grupo_id) VALUES (?, ?)');
          gruposArray.forEach(grupoId => {
            if (grupoId) stmtGrupos.run(id, grupoId);
          });

          stmtGrupos.finalize(() => res.redirect(`/profesores/${id}`));
        });
      });
    });
  });

  // Función auxiliar
  function recargarFormulario(error) {
    db.all('SELECT * FROM grupos', (err1, gruposAll) => {
      db.all('SELECT * FROM instrumentos', (err2, instrumentosAll) => {
        res.render('profesor_form', {
          error,
          profesor: {
            nombre,
            apellidos,
            email,
            telefono,
            direccion,
            fecha_nacimiento,
            especialidad,
            activo
          },
          grupos: gruposAll,
          instrumentos: instrumentosAll,
          gruposProfesor: Array.isArray(grupos) ? grupos.map(Number) : grupos ? [Number(grupos)] : [],
          instrumentosProfesor: Array.isArray(instrumentos) ? instrumentos.map(Number) : instrumentos ? [Number(instrumentos)] : []
        });
      });
    });
  }
});

// GET: Listado
router.get('/', (req, res) => {
  let estado = req.query.estado;
  const busqueda = req.query.busqueda || '';

  let sql = 'SELECT * FROM profesores';
  const params = [];
  const condiciones = [];

  if (estado === '0' || estado === '1') {
    condiciones.push('activo = ?');
    params.push(parseInt(estado));
  } else {
    estado = ''; // Por defecto muestra todos si no se especifica
  }

  if (busqueda.trim()) {
    condiciones.push('(nombre LIKE ? OR apellidos LIKE ?)');
    params.push(`%${busqueda}%`, `%${busqueda}%`);
  }

  if (condiciones.length > 0) {
    sql += ' WHERE ' + condiciones.join(' AND ');
  }

  db.all(sql, params, (err, profesores) => {
    if (err) return res.status(500).send('Error al obtener profesores');
    res.render('profesores_lista', { profesores, estado, busqueda, hero: false });
  });
});

// GET: Ficha
router.get('/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM profesores WHERE id = ?', [id], (err, profesor) => {
    if (err || !profesor) return res.status(404).send('Profesor no encontrado');

    db.all(
      `SELECT i.nombre FROM instrumentos i
       JOIN profesor_instrumento pi ON i.id = pi.instrumento_id
       WHERE pi.profesor_id = ?`,
      [id],
      (err2, instrumentos) => {
        if (err2) instrumentos = [];

        db.all(
          `SELECT g.nombre FROM grupos g
           JOIN profesor_grupo pg ON g.id = pg.grupo_id
           WHERE pg.profesor_id = ?`,
          [id],
          (err3, grupos) => {
            if (err3) grupos = [];

            const nombresInstrumentos = instrumentos.map(i => i.nombre);
            const nombresGrupos = grupos.map(g => g.nombre);

            res.render('profesores_ficha', {
              profesor,
              instrumentos: nombresInstrumentos,
              grupos: nombresGrupos
            });
          }
        );
      }
    );
  });
});

module.exports = router;
