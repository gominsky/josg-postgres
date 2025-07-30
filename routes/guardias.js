async function filtrarAlumnosOcupados(alumnos, fecha_inicio, callback) {
  try {
    const sql = `
      SELECT alumno_id_1, alumno_id_2
      FROM guardias
      WHERE fecha_inicio = $1
    `;
    const result = await db.query(sql, [fecha_inicio]);

    const ocupados = new Set();
    result.rows.forEach(row => {
      if (row.alumno_id_1) ocupados.add(row.alumno_id_1);
      if (row.alumno_id_2) ocupados.add(row.alumno_id_2);
    });

    const libres = alumnos.filter(al => !ocupados.has(al.id));
    callback(null, libres);
  } catch (err) {
    console.error('Error filtrando alumnos ocupados:', err.message);
    callback(err);
  }
}
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const getCursoActual = () => {
  const hoy = new Date();
  const año = hoy.getFullYear();
  return hoy.getMonth() >= 7 ? `${año}/${año + 1}` : `${año - 1}/${año}`;
};
//librerías externas
const PDFDocument = require('pdfkit');
const fs = require('fs');
const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

// routes/guardias.js
router.get('/', async (req, res) => {
  const { desde, hasta, busqueda, grupo } = req.query;

  try {
    // Obtener grupos para el filtro SELECT
    const gruposResult = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const grupos = gruposResult.rows;

    // Construir condiciones dinámicas
    const condiciones = [];
    const params = [];

    let sql = `
      SELECT 
        e.id AS evento_id,
        e.titulo AS evento,
        e.fecha_inicio,
        gr.nombre AS grupo,
        g.id AS guardia_id,
        g.notas,
        a1.nombre || ' ' || a1.apellidos AS guardia1,
        a2.nombre || ' ' || a2.apellidos AS guardia2
      FROM eventos e
      LEFT JOIN guardias g ON g.evento_id = e.id
      LEFT JOIN alumnos a1 ON g.alumno_id_1 = a1.id
      LEFT JOIN alumnos a2 ON g.alumno_id_2 = a2.id
      LEFT JOIN grupos gr ON e.grupo_id = gr.id
    `;

    if (desde) {
      condiciones.push(`DATE(e.fecha_inicio) >= DATE($${params.length + 1})`);
      params.push(desde);
    }
    if (hasta) {
      condiciones.push(`DATE(e.fecha_inicio) <= DATE($${params.length + 1})`);
      params.push(hasta);
    }
    if (busqueda) {
      condiciones.push(`(
        LOWER(e.titulo) LIKE $${params.length + 1} OR
        LOWER(gr.nombre) LIKE $${params.length + 2} OR
        LOWER(a1.nombre || ' ' || a1.apellidos) LIKE $${params.length + 3} OR
        LOWER(a2.nombre || ' ' || a2.apellidos) LIKE $${params.length + 4}
      )`);
      const term = `%${busqueda.toLowerCase()}%`;
      params.push(term, term, term, term);
    }
    if (grupo) {
      condiciones.push(`gr.id = $${params.length + 1}`);
      params.push(grupo);
    }

    if (condiciones.length > 0) {
      sql += ' WHERE ' + condiciones.join(' AND ');
    }

    sql += ' ORDER BY e.fecha_inicio ASC';

    const result = await db.query(sql, params);
    const guardias = result.rows;

    res.render('guardias_lista', {
      title: 'Listado de Guardias',
      guardias,
      grupos,
      grupo,
      mensaje: req.session.mensaje,
      desde,
      hasta,
      busqueda
    });

    delete req.session.mensaje;

  } catch (error) {
    console.error('❌ Error al cargar guardias:', error.message);
    res.status(500).send('Error al cargar guardias');
  }
});
router.post('/generar', async (req, res) => {
  const { evento_id, desde, hasta } = req.body;
  const curso = getCursoActual();

  try {
    // Obtener fecha y grupo del evento
    const eventoResult = await db.query(`SELECT fecha_inicio, grupo_id FROM eventos WHERE id = $1`, [evento_id]);
    const evento = eventoResult.rows[0];
    if (!evento) return res.status(404).send('Evento no encontrado');

    const { fecha_inicio, grupo_id } = evento;

    // Alumnos activos del grupo
    const alumnosResult = await db.query(`
      SELECT a.id, a.nombre, a.apellidos, a.curso_ingreso, a.guardias_actual
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = 1
    `, [grupo_id]);
    const alumnos = alumnosResult.rows;

    // Alumnos ocupados ese día
    const ocupadosResult = await db.query(`
      SELECT alumno_id_1, alumno_id_2 FROM guardias WHERE fecha = $1
    `, [fecha_inicio]);
    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });

    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    if (!disponibles.length) {
      req.session.error = 'Sin alumnos disponibles para esta fecha';
      return res.redirect('/guardias');
    }

    const novatos = disponibles.filter(a => a.curso_ingreso === curso);
    const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);

    // Generar parejas válidas: un novato + un veterano preferiblemente
    let parejas = [];

    for (let v of veteranos) {
      for (let o of disponibles) {
        if (v.id !== o.id && (o.curso_ingreso === curso || v.curso_ingreso === curso)) {
          parejas.push([v, o]);
        }
      }
    }

    // Aleatorizar y ordenar por menor carga de guardias
    parejas = parejas.sort(() => Math.random() - 0.5).sort((a, b) => {
      const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
      const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
      return cargaA - cargaB;
    });

    if (!parejas.length) {
      req.session.error = 'No hay parejas válidas para esta guardia';
      return res.redirect('/guardias');
    }

    const [a1, a2] = parejas[0];

    // Insertar nueva guardia
    await db.query(`
      INSERT INTO guardias (evento_id, fecha, alumno_id_1, alumno_id_2, curso, notas)
      VALUES ($1, $2, $3, $4, $5, NULL)
    `, [evento_id, fecha_inicio, a1.id, a2.id, curso]);

    // Actualizar contadores
    await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a1.id]);
    await db.query(`UPDATE alumnos SET guardias_actual = guardias_actual + 1 WHERE id = $1`, [a2.id]);

    req.session.mensaje = 'Guardia sugerida correctamente ✅';
    const query = `?desde=${encodeURIComponent(desde || '')}&hasta=${encodeURIComponent(hasta || '')}`;
    res.redirect('/guardias' + query);

  } catch (error) {
    console.error('❌ Error al generar guardia:', error.message);
    res.status(500).send('Error al generar guardia');
  }
});
router.get('/editar/:id', async (req, res) => {
  const { id } = req.params;
  const { desde, hasta, grupo } = req.query;

  try {
    // Obtener datos de la guardia
    const result = await db.query(`
      SELECT g.*, e.titulo AS evento, e.grupo_id, e.fecha_inicio
      FROM guardias g
      JOIN eventos e ON g.evento_id = e.id
      WHERE g.id = $1
    `, [id]);

    const guardia = result.rows[0];
    if (!guardia) return res.status(404).send('Guardia no encontrada');

    const curso = getCursoActual();

    // Obtener alumnos activos del grupo
    const alumnosResult = await db.query(`
      SELECT a.id, a.nombre, a.apellidos, a.curso_ingreso, a.guardias_actual
      FROM alumnos a
      JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1 AND a.activo = 1
    `, [guardia.grupo_id]);

    const alumnos = alumnosResult.rows;

    // Obtener alumnos ya ocupados ese día
    const ocupadosResult = await db.query(`
      SELECT alumno_id_1, alumno_id_2
      FROM guardias
      WHERE fecha = $1 AND id <> $2
    `, [guardia.fecha, id]);

    const ocupados = new Set();
    ocupadosResult.rows.forEach(g => {
      if (g.alumno_id_1) ocupados.add(g.alumno_id_1);
      if (g.alumno_id_2) ocupados.add(g.alumno_id_2);
    });

    // Filtrar disponibles
    const disponibles = alumnos.filter(a => !ocupados.has(a.id));

    // Separar novatos/veteranos
    const novatos = disponibles.filter(a => a.curso_ingreso === curso);
    const veteranos = disponibles.filter(a => a.curso_ingreso !== curso);

    // Crear parejas válidas
    let parejas = [];
    for (let v of veteranos) {
      for (let otro of disponibles) {
        if (v.id !== otro.id &&
            (otro.curso_ingreso === curso || v.curso_ingreso === curso)) {
          parejas.push([v, otro]);
        }
      }
    }

    parejas = parejas.sort(() => Math.random() - 0.5)
      .sort((a, b) => {
        const cargaA = (a[0].guardias_actual || 0) + (a[1].guardias_actual || 0);
        const cargaB = (b[0].guardias_actual || 0) + (b[1].guardias_actual || 0);
        return cargaA - cargaB;
      });

    res.render('guardias_editar', {
      guardia,
      eventoTitulo: guardia.evento,
      disponibles,
      parejas,
      desde,
      hasta,
      grupo
    });

  } catch (err) {
    console.error('❌ Error al editar guardia:', err.message);
    res.status(500).send('Error al cargar datos de la guardia');
  }
});
router.get('/evento/:eventoId', (req, res) => {
  const { eventoId } = req.params;
  res.send(`🔍 Ver guardias para el evento con ID: ${eventoId}`);
});
module.exports = router;