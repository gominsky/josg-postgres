// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const fs = require('fs');
const { isAuthenticated } = require('../middleware/auth');

// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/lista');
});
router.get('/ficha', async (req, res) => {
  try {
    const gruposResult = await db.query('SELECT * FROM grupos ORDER BY nombre');
    const instrumentosResult = await db.query('SELECT * FROM instrumentos ORDER BY nombre');

    res.render('informe_form', {
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      alumnos: [],
      campos: [],
      nombreInforme: '',
      grupoSeleccionado: 'todos',
      instrumentoSeleccionado: 'todos',
      fechaHoy: new Date().toISOString().split('T')[0],
      showGroup: false,
      showInstrument: false
    });
  } catch (error) {
    console.error('Error cargando formulario de informe:', error);
    res.status(500).send('Error cargando datos');
  }
});
router.get('/ficha/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const informeResult = await db.query('SELECT * FROM informes WHERE id = $1', [id]);
    const informe = informeResult.rows[0];

    if (!informe) {
      return res.status(404).send('Informe no encontrado');
    }

    const gruposResult = await db.query('SELECT * FROM grupos ORDER BY nombre');
    const instrumentosResult = await db.query('SELECT * FROM instrumentos ORDER BY nombre');
    const camposResult = await db.query('SELECT * FROM informe_campos WHERE informe_id = $1 ORDER BY id', [id]);
    const alumnosResult = await db.query('SELECT * FROM alumnos ORDER BY apellidos, nombre');
    const resultadosResult = await db.query('SELECT * FROM informe_resultados WHERE informe_id = $1', [id]);

    res.render('informe_form', {
      informeId: id,
      nombreInforme: informe.informe,
      grupoSeleccionado: informe.grupo_id || 'todos',
      instrumentoSeleccionado: informe.instrumento_id || 'todos',
      profesorSeleccionado: null,
      fechaHoy: informe.fecha,
      fecha_fin: informe.fecha,
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      campos: camposResult.rows,
      alumnos: alumnosResult.rows,
      resultados: resultadosResult.rows,
      showGroup: false,
      showInstrument: false
    });

  } catch (err) {
    console.error('Error cargando informe:', err);
    res.status(500).send('Error al cargar informe');
  }
});
router.get('/lista', async (req, res) => {
  try {
    const { rows: informes } = await db.query(`
      SELECT inf.id, inf.informe, inf.fecha,
             g.nombre AS grupo,
             i.nombre AS instrumento
      FROM informes inf
      LEFT JOIN grupos g ON inf.grupo_id = g.id
      LEFT JOIN instrumentos i ON inf.instrumento_id = i.id
      ORDER BY inf.fecha DESC
    `);

    // Normaliza campos null
    informes.forEach(i => {
      i.grupo = i.grupo || 'Ninguno';
      i.instrumento = i.instrumento || 'Ninguno';
    });

    res.render('informes_lista', { informes });
  } catch (err) {
    console.error('Error cargando informes:', err);
    res.status(500).send('Error al cargar informes');
  }
});
router.post('/ficha/guardar-json', async (req, res) => {
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    resultados,
    campos_json,
    informeId
  } = req.body;

  const parsedResultados = JSON.parse(resultados || '[]');
  const parsedCampos = JSON.parse(campos_json || '[]');

  const grupoIdFinal = grupo_id === 'ninguno' ? null : grupo_id;
  const instrumentoIdFinal = instrumento_id === 'ninguno' ? null : instrumento_id;

  try {
    let informeIdFinal = informeId;

    // 1. Crear nuevo informe si no hay ID
    if (!informeIdFinal) {
      const insert = await db.query(
        `INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nombre_informe, grupoIdFinal, instrumentoIdFinal, fecha]
      );
      informeIdFinal = insert.rows[0].id;
    } else {
      // Actualizar el nombre si ya existía
      await db.query(
        `UPDATE informes SET informe = $1 WHERE id = $2`,
        [nombre_informe, informeIdFinal]
      );
    }

    // 2. Borrar campos y resultados previos
    await db.query(`DELETE FROM informe_resultados WHERE informe_id = $1`, [informeIdFinal]);
    await db.query(`DELETE FROM informe_campos WHERE informe_id = $1`, [informeIdFinal]);

    // 3. Insertar campos nuevos
    const campoInsert = `INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio) VALUES ($1, $2, $3, $4) RETURNING id`;
    const camposIds = [];

    for (const campo of parsedCampos) {
      const result = await db.query(campoInsert, [
        informeIdFinal,
        campo.nombre,
        campo.tipo,
        campo.obligatorio ? 1 : 0
      ]);
      camposIds.push(result.rows[0].id);
    }

    // 4. Insertar resultados por alumno y campo
    const resultadoInsert = `
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
      VALUES ($1, $2, $3, $4)
    `;

    for (const r of parsedResultados) {
      for (let i = 0; i < camposIds.length; i++) {
        const campoId = camposIds[i];
        const valor = r[`campo_${i}`] ?? '';
        await db.query(resultadoInsert, [
          informeIdFinal,
          r.alumno_id || null,
          campoId,
          valor
        ]);
      }
    }

    res.redirect(`/informes/detalle/${informeIdFinal}`);
  } catch (err) {
    console.error('❌ Error al guardar informe JSON:', err);
    res.status(500).send('Error al guardar informe');
  }
});
router.post('/detalle/:id', async (req, res) => {
  const id = req.params.id;
  const resultados = JSON.parse(req.body.resultados || '[]');

  try {
    // 1. Eliminar resultados existentes
    await db.query('DELETE FROM informe_resultados WHERE informe_id = $1', [id]);

    // 2. Obtener los campos definidos en el informe (en orden)
    const camposResult = await db.query(
      'SELECT id FROM informe_campos WHERE informe_id = $1 ORDER BY id',
      [id]
    );
    const campos = camposResult.rows;

    // 3. Insertar nuevos resultados por alumno y campo
    const insertSQL = `
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
      VALUES ($1, $2, $3, $4)
    `;

    for (const r of resultados) {
      for (let i = 0; i < campos.length; i++) {
        const campoId = campos[i].id;
        const valor = r[`campo_${i}`] ?? '';
        await db.query(insertSQL, [id, r.alumno_id || null, campoId, valor]);
      }
    }

    res.redirect(`/informes/detalle/${id}`);
  } catch (err) {
    console.error('❌ Error guardando resultados del informe:', err);
    res.status(500).send('Error guardando datos del informe');
  }
});
router.post('/horas/guardar', isAuthenticated, async (req, res) => {
  const { fecha, fecha_fin, grupo, instrumento, resultados } = req.body;
  const parsed = JSON.parse(resultados || '[]');

  const opts = { day: '2-digit', month: 'long', year: 'numeric' };
  const fi = new Date(fecha).toLocaleDateString('es-ES', opts);
  const ff = fecha_fin
    ? new Date(fecha_fin).toLocaleDateString('es-ES', opts)
    : null;

  const nombreInforme = `Porcentaje de horas de asistencia (${fi}` +
    (ff ? ` – ${ff}` : '') + `)`;

  try {
    // 1. Insertar informe
    const result = await db.query(`
      INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [
      nombreInforme,
      grupo === 'todos' ? null : grupo,
      instrumento === 'todos' ? null : instrumento,
      fecha_fin
    ]);
    const informeId = result.rows[0].id;

    // 2. Insertar los campos: Alumno, Horas, Porcentaje
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, 0)
      RETURNING id
    `;
    const campoAlumno = (await db.query(campoInsert, [informeId, 'Alumno', 'numero'])).rows[0].id;
    const campoHoras = (await db.query(campoInsert, [informeId, 'Horas', 'numero'])).rows[0].id;
    const campoPorcentaje = (await db.query(campoInsert, [informeId, 'Porcentaje', 'numero'])).rows[0].id;

    // 3. Insertar resultados para cada alumno
    const resInsert = `
      INSERT INTO informe_resultados (informe_id, alumno_id, campo_id, valor)
      VALUES ($1, $2, $3, $4)
    `;
    for (const r of parsed) {
      await db.query(resInsert, [informeId, r.alumno_id, campoAlumno, String(r.alumno_id)]);
      await db.query(resInsert, [informeId, r.alumno_id, campoHoras, String(r.horas)]);
      await db.query(resInsert, [informeId, r.alumno_id, campoPorcentaje, String(r.porcentaje)]);
    }

    res.redirect(`/informes/detalle/${informeId}`);
  } catch (err) {
    console.error('❌ Error al guardar informe de horas:', err);
    res.status(500).send('Error al guardar el informe');
  }
});
module.exports = router;