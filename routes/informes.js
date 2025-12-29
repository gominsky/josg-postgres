// routes/informes.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const fs = require('fs');
const { isAuthenticated } = require('../middleware/auth');
const { toISODate } = require('../utils/fechas');
router.use(express.json());

// === Helpers curso/trimestre para "Prueba de atril" (curso desde 1 de agosto) ===
function _norm(s){
  return (s||'').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}

// Domingo de Pascua (algoritmo gregoriano)
function _easterSunday(year){
  const a=year%19, b=Math.floor(year/100), c=year%100,
        d=Math.floor(b/4), e=b%4, f=Math.floor((b+8)/25),
        g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7,
        m=Math.floor((a+11*h+22*l)/451),
        month=Math.floor((h+l-7*m+114)/31),
        day=((h+l-7*m+114)%31)+1;
  return new Date(year, month-1, day); // local
}

// Curso desde 1 de agosto; T2 desde Navidad; T3 desde lunes tras Pascua
function _cursoYTrimestre(fechaISO){
  const d = fechaISO ? new Date(fechaISO + 'T12:00:00') : new Date();
  const y = d.getFullYear(), m = d.getMonth()+1;
  const yStart = (m >= 8) ? y : (y - 1);
  const yEnd   = yStart + 1;
  const curso  = String(yStart % 100).padStart(2,'0') + '/' + String(yEnd % 100).padStart(2,'0');

  // T2: desde 25/dic del año de inicio
  const navidad = new Date(yStart, 11, 25, 12); // 25-dic
  // T3: lunes tras Pascua del año siguiente
  const pascua  = _easterSunday(yStart + 1);
  const inicioT3 = new Date(pascua); inicioT3.setDate(pascua.getDate() + 1); // lunes

  let trimestre = 'T1';
  if (d >= navidad && d < inicioT3) trimestre = 'T2';
  else if (d >= inicioT3)          trimestre = 'T3';

  return { curso, trimestre };
}

// Quita sufijo final " 25/26T1|T2|T3" si ya lo tuviera (evita duplicados)
function _stripSuffix(nombre){
  return String(nombre||'').replace(/\s+\d{2}\/\d{2}T[123]\s*$/i,'').trim();
}

// Completa el título SOLO si empieza por "prueba de atril"
function completaTituloPruebaAtril(nombre, fechaISO){
  const base = _stripSuffix(nombre);
  if (!_norm(base).startsWith('prueba de atril')) return base;
  const { curso, trimestre } = _cursoYTrimestre(fechaISO);
  return `${base} ${curso}${trimestre}`.trim();
}



// ⛔️ Anti-caché para todo lo de /ficha (GET y POST)
router.get('/ayuda', (_req, res) => {
  res.render('ayuda_informes', { title: 'Ayuda · Informes y certificados', hero: false });
});
router.use('/ficha', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// Redirigir a lista
router.get('/', (req, res) => {
  res.redirect('/informes/certificados');
});
router.get('/ficha', async (req, res) => {
  try {
    const [gruposResult, instrumentosResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM instrumentos ORDER BY nombre')
    ]);

    const q = req.query || {};
    const norm = v => (v == null ? '' : String(v));

    // Acepta ambos nombres de parámetros (compatibilidad)
    const rawGrupo = norm(q.grupo || q.grupo_id);              // 'todos' | 'ninguno' | <id> | ''
    const rawInst  = norm(q.instrumento || q.instrumento_id);  // 'todos' | <id> | ''
    const secViolin = norm(q.sec_violin).replace(/\s+/g,'').toUpperCase(); // '', 'I', 'II'
    const f1ISO    = toISODate(q.fecha);
    const f2ISO    = toISODate(q.fecha_fin); // (no se usa para alumnos)

    // Mapeo robusto ('' → 'todos')
    const selGrupo = rawGrupo === '' ? 'todos' : rawGrupo;
    const selInst  = rawInst  === '' ? 'todos' : rawInst;

    // ¿El instrumento seleccionado es "Violín"?
    const isViolinSelected = (() => {
      if (selInst === 'todos' || selInst === 'ninguno' || selInst === '') return false;
      const inst = instrumentosResult.rows.find(x => String(x.id) === String(selInst));
      if (!inst) return false;
      const t = (inst.nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
      return t === 'violin';
    })();

    let alumnos  = [];
    let filtrado = false;

    // Si venimos desde “Informes y certificados” con algún filtro, filtramos YA
    const vieneConFiltros = (rawGrupo !== '' || rawInst !== '' || !!f1ISO || !!secViolin);
    if (vieneConFiltros) {
      filtrado = true;

      // Sólo “sin alumnos” si el grupo es literalmente 'ninguno'
      if (selGrupo !== 'ninguno') {
        let sql = `
          SELECT DISTINCT a.id, a.nombre, a.apellidos
          FROM alumnos a
          LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
          LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
          WHERE a.activo = true
        `;
        const params = [];
        let i = 1;

        if (selGrupo !== 'todos') {
          sql += ` AND ag.grupo_id = $${i++}`;
          params.push(selGrupo);
        }
        if (selInst !== 'todos') {
          sql += ` AND ai.instrumento_id = $${i++}`;
          params.push(selInst);
        }

        // 🔹 Filtro de sección de violín (sólo si viene I/II y el instrumento es Violín)
        if ((secViolin === 'I' || secViolin === 'II') && isViolinSelected) {
          sql += `
            AND EXISTS (
              SELECT 1
              FROM alumno_grupo ag2
              JOIN grupos g2 ON g2.id = ag2.grupo_id
              WHERE ag2.alumno_id = a.id
                AND g2.nombre = $${i++}
            )`;
          params.push(`Violín ${secViolin}`);
        }

        sql += ' ORDER BY a.apellidos, a.nombre';

        const { rows: base } = await db.query(sql, params);

        // añade nombres de grupos/instrumentos de cada alumno
        alumnos = await Promise.all(base.map(async a => {
          const [gRes, iRes] = await Promise.all([
            db.query(`
              SELECT g.nombre
              FROM grupos g
              JOIN alumno_grupo ag ON g.id = ag.grupo_id
              WHERE ag.alumno_id = $1
              ORDER BY g.nombre
            `, [a.id]),
            db.query(`
              SELECT i.nombre
              FROM instrumentos i
              JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
              WHERE ai.alumno_id = $1
              ORDER BY i.nombre
            `, [a.id])
          ]);
          return {
            id: a.id,
            nombre: a.nombre,
            apellidos: a.apellidos,
            grupos: gRes.rows.map(r => r.nombre).join(', '),
            instrumentos: iRes.rows.map(r => r.nombre).join(', ')
          };
        }));
      }
    }

    // Resuelve nombre legible (ids -> nombres) para el título sugerido
    const nombreDeGrupo = (() => {
      if (selGrupo === 'todos') return 'Todos';
      if (selGrupo === 'ninguno') return 'Ninguno';
      const g = gruposResult.rows.find(x => String(x.id) === String(selGrupo));
      return g ? g.nombre : (selGrupo || '');
    })();
    const nombreDeInstr = (() => {
      if (selInst === 'todos') return 'Todos';
      const i = instrumentosResult.rows.find(x => String(x.id) === String(selInst));
      return i ? i.nombre : (selInst || '');
    })();

    // Nombre sugerido sin fecha_fin ni guiones
    const construirNombreSugerido = ({ g, i, d1, sec }) => {
      const partes = ['Listado'];
      if (g) partes.push(g === 'Ninguno' ? 'Sin alumnos' : `Grupo ${g}`);
      if (i) partes.push(`Instr. ${i}`);
      if (sec === 'I')  partes.push('(Violín I)');
      if (sec === 'II') partes.push('(Violín II)');
      if (d1) partes.push(d1);
      return partes.join(' ');
    };
    const nombreInforme = construirNombreSugerido({
      g: nombreDeGrupo,
      i: nombreDeInstr,
      sec: secViolin || '',
      d1: f1ISO || ''
    });

    res.render('informe_form', {
      grupos: gruposResult.rows,
      instrumentos: instrumentosResult.rows,
      alumnos,                  // ← ya filtrados (o vacío si 'ninguno')
      campos: [],
      nombreInforme,
      grupoSeleccionado: selGrupo,
      instrumentoSeleccionado: selInst,
      profesorSeleccionado: null,
      fechaHoy: f1ISO || new Date().toISOString().slice(0,10),
      fecha_fin: '',
      showGroup: false,
      showInstrument: false,
      desdeIC: vieneConFiltros,
      filtrado,
      // 👇 clave: el EJS espera "sec_violin"
      sec_violin: secViolin
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

    if (!informe) return res.status(404).send('Informe no encontrado');

    const [gruposResult, instrumentosResult, camposResult, alumnosResult, resultadosResult] = await Promise.all([
      db.query('SELECT * FROM grupos ORDER BY nombre'),
      db.query('SELECT * FROM instrumentos ORDER BY nombre'),
      db.query('SELECT * FROM informe_campos WHERE informe_id = $1 ORDER BY id', [id]),
      db.query('SELECT * FROM alumnos ORDER BY apellidos, nombre'),
      db.query('SELECT * FROM informe_resultados WHERE informe_id = $1', [id])
    ]);

    res.render('informe_form', {
      informeId: id,
      nombreInforme: informe.informe,
      grupoSeleccionado: informe.grupo_id || 'todos',
      instrumentoSeleccionado: informe.instrumento_id || 'todos',
      profesorSeleccionado: null,
      fechaHoy: toISODate(informe.fecha) || new Date().toISOString().split('T')[0],
      fecha_fin: toISODate(informe.fecha) || new Date().toISOString().split('T')[0],
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

    informes.forEach(i => {
      i.grupo = i.grupo || 'Ninguno';
      i.instrumento = i.instrumento || 'Ninguno';
      i.fecha = toISODate(i.fecha) || i.fecha; // normaliza para la vista si procede
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
  const parsedCampos     = JSON.parse(campos_json || '[]');

  // ---- Normalización y AUTO-CAMPOS "Prueba de atril ..." ----
  const norm = (s) => (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const esPruebaAtril = norm(nombre_informe).startsWith('prueba de atril');

  // Limpia/normaliza el array recibido
  const normalizeCampo = (c) => ({
    nombre: (c?.nombre ?? '').toString().trim(),
    tipo: ['texto','numero','booleano'].includes(c?.tipo) ? c.tipo : 'texto',
    obligatorio: !!c?.obligatorio
  });
  let camposWork = parsedCampos.map(normalizeCampo);

  if (esPruebaAtril) {
    const tieneNombre = (arr, ...nombres) =>
      arr.some(c => nombres.some(n => norm(c.nombre) === norm(n)));

    if (!tieneNombre(camposWork, 'Puntuación', 'Puntuacion')) {
      camposWork.push({ nombre: 'Puntuación', tipo: 'numero',   obligatorio: false });
    }
    if (!tieneNombre(camposWork, 'Asistencia')) {
      camposWork.push({ nombre: 'Asistencia', tipo: 'booleano', obligatorio: false });
    }
  }
  // ---- FIN AUTO-CAMPOS ----

  const fechaISO = toISODate(fecha) || new Date().toISOString().slice(0, 10);

  // 👇 TÍTULO FINAL: si es “Prueba de atril…”, añade curso+trimestre (y reemplaza si ya hay)
  let nombreFinal = (nombre_informe || '').toString().trim();
  if (esPruebaAtril) {
    nombreFinal = completaTituloPruebaAtril(nombreFinal, fechaISO);
  }

  const grupoIdFinal = ['ninguno', 'todos', '', null, undefined].includes(grupo_id) ? null : Number(grupo_id);
  const instrumentoIdFinal = ['ninguno', 'todos', '', null, undefined].includes(instrumento_id) ? null : Number(instrumento_id);

  try {
    let informeIdFinal = informeId;

    // 1. Crear nuevo informe si no hay ID
    if (!informeIdFinal) {
      const insert = await db.query(
        `INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nombreFinal, grupoIdFinal, instrumentoIdFinal, fechaISO]
      );
      informeIdFinal = insert.rows[0].id;
    } else {
      // Actualizar nombre y fecha
      await db.query(
        `UPDATE informes SET informe = $1, fecha = $2 WHERE id = $3`,
        [nombreFinal, fechaISO, informeIdFinal]
      );
    }

    // 2. Borrar campos y resultados previos
    await db.query(`DELETE FROM informe_resultados WHERE informe_id = $1`, [informeIdFinal]);
    await db.query(`DELETE FROM informe_campos WHERE informe_id = $1`, [informeIdFinal]);

    // 3. Insertar campos
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const camposIds = [];
    for (const campo of camposWork) {
      const r = await db.query(campoInsert, [
        informeIdFinal,
        campo.nombre,
        campo.tipo,
        Boolean(campo.obligatorio)
      ]);
      camposIds.push(r.rows[0].id);
    }

    // 4. Insertar resultados por alumno/campo
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

router.get('/detalle/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const { rows: [informe] } = await db.query(`
      SELECT i.*, 
             g.nombre AS "informeGrupo", 
             inst.nombre AS "informeInstrumento"
      FROM informes i
      LEFT JOIN grupos g ON i.grupo_id = g.id
      LEFT JOIN instrumentos inst ON i.instrumento_id = inst.id
      WHERE i.id = $1
    `, [id]);

    if (!informe) return res.status(404).send('Informe no encontrado');

    const showGroup = informe.grupo_id != null;
    const showInstrument = informe.instrumento_id != null;

    const [{ rows: campos }, { rows: resultados }] = await Promise.all([
      db.query(`SELECT * FROM informe_campos WHERE informe_id = $1 ORDER BY id`, [id]),
      db.query(`
        SELECT ir.*, a.nombre, a.apellidos
        FROM informe_resultados ir
        LEFT JOIN alumnos a ON ir.alumno_id = a.id
        WHERE ir.informe_id = $1 AND (a.id IS NULL OR a.activo = true)
      `, [id])
    ]);

    const filasMap = {};
    for (const r of resultados) {
      const key = r.alumno_id !== null ? `a_${r.alumno_id}` : `f_${r.fila}`;
      if (!filasMap[key]) {
        filasMap[key] = {
          alumno_id: r.alumno_id,
          fila: r.fila,
          nombre: r.nombre || '',
          apellidos: r.apellidos || '',
          valores: {}
        };
      }
      filasMap[key].valores[r.campo_id] = r.valor;
    }

    let filas = Object.values(filasMap);

    for (const f of filas) {
      if (!f.alumno_id) {
        f.grupos = '';
        f.instrumentos = '';
        continue;
      }
      const [gruposRes, instrumentosRes] = await Promise.all([
        db.query(`
          SELECT g.nombre
          FROM grupos g
          JOIN alumno_grupo ag ON ag.grupo_id = g.id
          WHERE ag.alumno_id = $1
          ORDER BY g.nombre
        `, [f.alumno_id]),
        db.query(`
          SELECT i.nombre
          FROM instrumentos i
          JOIN alumno_instrumento ai ON ai.instrumento_id = i.id
          WHERE ai.alumno_id = $1
          ORDER BY i.nombre
        `, [f.alumno_id])
      ]);

      f.grupos = gruposRes.rows.map(r => r.nombre).join(', ');
      f.instrumentos = instrumentosRes.rows.map(r => r.nombre).join(', ');
    }

    filas.sort((a, b) => {
      if (a.alumno_id && b.alumno_id) {
        return a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre);
      }
      if (!a.alumno_id && !b.alumno_id) {
        return (a.fila || 0) - (b.fila || 0);
      }
      return a.alumno_id ? -1 : 1;
    });

    const tieneAlumnos = filas.some(f => f.alumno_id !== null);

    res.render('informes_detalle', {
      informe: { ...informe, fecha: toISODate(informe.fecha) || informe.fecha },
      publicSlug: informe.public_slug,
      campos,
      filas,
      tieneAlumnos,
      showGroup,
      showInstrument
    });

  } catch (err) {
    console.error('Error procesando informe:', err);
    res.status(500).send('Error procesando informe');
  }
});

router.post('/detalle/:id', async (req, res) => {
  const id = req.params.id;
  const resultados = JSON.parse(req.body.resultados || '[]');

  try {
    await db.query('DELETE FROM informe_resultados WHERE informe_id = $1', [id]);

    const insertSQL = `
      INSERT INTO informe_resultados (informe_id, alumno_id, fila, campo_id, valor)
      VALUES ($1, $2, $3, $4, $5)
    `;
    for (const r of resultados) {
      const alumnoId = r.alumno_id ?? null;
      const fila = r.fila ?? null;
      const campoId = r.campo_id;
      const valor = r.valor ?? '';
      await db.query(insertSQL, [id, alumnoId, fila, campoId, valor]);
    }
    res.redirect(`/informes/detalle/${id}`);
  } catch (err) {
    console.error('❌ Error guardando resultados del informe:', err);
    res.status(500).send('Error guardando datos del informe');
  }
});

router.post('/ficha/filtrar', async (req, res) => {
  const {
    nombre_informe,
    grupo_id,
    instrumento_id,
    fecha,
    fecha_fin,
    mostrar_grupo,
    mostrar_instrumento,
    sec_violin        // '' | 'I' | 'II'
  } = req.body;

  const showGroup = !!mostrar_grupo;
  const showInstrument = !!mostrar_instrumento;

  const fechaISO    = toISODate(fecha)     || new Date().toISOString().slice(0, 10);
  const fechaFinISO = toISODate(fecha_fin) || fechaISO;
  const secViolin   = String(sec_violin || '').replace(/\s+/g,'').toUpperCase(); // '', 'I', 'II'

  try {
    // 👉 Modo "sin alumnos" literal
    if (grupo_id === 'ninguno') {
      const [gruposRes, instrumentosRes] = await Promise.all([
        db.query('SELECT * FROM grupos ORDER BY nombre'),
        db.query('SELECT * FROM instrumentos ORDER BY nombre')
      ]);

      return res.render('informe_form', {
        grupos: gruposRes.rows,
        instrumentos: instrumentosRes.rows,
        alumnos: [],                     // sin alumnos
        campos: [],
        nombreInforme: (nombre_informe || '').trim(),
        grupoSeleccionado: 'ninguno',
        instrumentoSeleccionado: instrumento_id || 'todos',
        profesorSeleccionado: null,
        fechaHoy: fechaISO,
        fecha_fin: fechaFinISO,
        showGroup,
        showInstrument,
        filtrado: true,
        sec_violin: secViolin          // 👈 mantener en la vista
      });
    }

    // Catálogos (para sugerido y para detectar si el instrumento es Violín)
    const [gruposRes, instrumentosRes] = await Promise.all([
      db.query('SELECT id, nombre FROM grupos ORDER BY nombre'),
      db.query('SELECT id, nombre FROM instrumentos ORDER BY nombre')
    ]);

    // ¿El instrumento seleccionado es "Violín"?
    const isViolinSelected = (() => {
      if (!instrumento_id || instrumento_id === 'todos' || instrumento_id === 'ninguno') return false;
      const inst = instrumentosRes.rows.find(x => String(x.id) === String(instrumento_id));
      if (!inst) return false;
      const t = (inst.nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
      return t === 'violin';
    })();

    // Query de alumnos con filtros
    let sql = `
      SELECT DISTINCT a.id, a.nombre, a.apellidos
      FROM alumnos a
      LEFT JOIN alumno_grupo ag ON a.id = ag.alumno_id
      LEFT JOIN alumno_instrumento ai ON a.id = ai.alumno_id
      WHERE a.activo = true
    `;
    const params = [];
    let i = 1;

    if (grupo_id !== 'todos') {
      if (grupo_id === 'ninguno') {
        sql += ' AND ag.grupo_id IS NULL';
      } else {
        sql += ` AND ag.grupo_id = $${i++}`;
        params.push(grupo_id);
      }
    }

    if (instrumento_id !== 'todos') {
      if (instrumento_id === 'ninguno') {
        sql += ' AND ai.instrumento_id IS NULL';
      } else {
        sql += ` AND ai.instrumento_id = $${i++}`;
        params.push(instrumento_id);
      }
    }

    // 🔹 Sección de violín solo si procede (I/II y el instrumento es Violín)
    if (isViolinSelected && (secViolin === 'I' || secViolin === 'II')) {
      sql += `
        AND EXISTS (
          SELECT 1
          FROM alumno_grupo ag2
          JOIN grupos g2 ON g2.id = ag2.grupo_id
          WHERE ag2.alumno_id = a.id
            AND g2.nombre = $${i++}
        )`;
      params.push(`Violín ${secViolin}`);
    }

    sql += ' ORDER BY a.apellidos, a.nombre';

    const { rows: alumnosBase } = await db.query(sql, params);

    const alumnos = await Promise.all(alumnosBase.map(async a => {
      const [gDet, iDet] = await Promise.all([
        db.query(`
          SELECT g.nombre
          FROM grupos g
          JOIN alumno_grupo ag ON g.id = ag.grupo_id
          WHERE ag.alumno_id = $1
          ORDER BY g.nombre
        `, [a.id]),
        db.query(`
          SELECT i.nombre
          FROM instrumentos i
          JOIN alumno_instrumento ai ON i.id = ai.instrumento_id
          WHERE ai.alumno_id = $1
          ORDER BY i.nombre
        `, [a.id])
      ]);

      return {
        id: a.id,
        nombre: a.nombre,
        apellidos: a.apellidos,
        grupos: gDet.rows.map(r => r.nombre).join(', '),
        instrumentos: iDet.rows.map(r => r.nombre).join(', ')
      };
    }));

    // Sugerencia de nombre si viene vacío
    const gName = (() => {
      if (grupo_id === 'todos')   return null;
      if (grupo_id === 'ninguno') return 'Ninguno';
      const g = gruposRes.rows.find(x => String(x.id) === String(grupo_id));
      return g ? g.nombre : null;
    })();
    const iName = (() => {
      if (instrumento_id === 'todos') return null;
      const i = instrumentosRes.rows.find(x => String(x.id) === String(instrumento_id));
      return i ? i.nombre : null;
    })();
    const sugerido = (() => {
      const piezas = ['Listado'];
      if (gName) piezas.push(gName === 'Ninguno' ? 'Sin alumnos' : `${gName}`);
      if (iName) piezas.push(`${iName}`);
      if (isViolinSelected && secViolin === 'I')  piezas.push('(Violín I)');
      if (isViolinSelected && secViolin === 'II') piezas.push('(Violín II)');
      if (fechaISO) piezas.push(fechaISO);
      return piezas.join(' ');
    })();

    res.render('informe_form', {
      grupos: gruposRes.rows,
      instrumentos: instrumentosRes.rows,
      alumnos,
      campos: [],
      nombreInforme: (nombre_informe && nombre_informe.trim()) ? nombre_informe.trim() : sugerido,
      grupoSeleccionado: grupo_id,
      instrumentoSeleccionado: instrumento_id,
      profesorSeleccionado: null,
      fechaHoy: fechaISO,
      fecha_fin: fechaFinISO,
      showGroup,
      showInstrument,
      desdeIC: true,                                                     // modo “solo nombre” en el paso 1
      filtrado: (grupo_id === 'ninguno') || (alumnos && alumnos.length), // “saltar” al paso 2
      sec_violin: secViolin                                            // 👈 persistir en la vista
    });

  } catch (err) {
    console.error('Error en /ficha/filtrar:', err);
    res.status(500).send('Error al procesar formulario');
  }
});

router.post('/eliminar/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.query('DELETE FROM informe_resultados WHERE informe_id = $1', [id]);
    await db.query('DELETE FROM informe_campos WHERE informe_id = $1', [id]);
    await db.query('DELETE FROM informes WHERE id = $1', [id]);

    res.redirect('/informes/lista');
  } catch (err) {
    console.error('Error al eliminar informe:', err);
    res.status(500).send('Error al eliminar informe');
  }
});

// Actualizar solo el título del informe (AJAX)
router.post('/:id/titulo', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  let   titulo = (req.body?.titulo || '').toString().trim();

  // Permite títulos largos (ajusta a tus límites reales)
  const MAX_LEN = 255;               // sube a 500 o usa TEXT si quieres “sin límite”
  titulo = titulo.slice(0, MAX_LEN);

  try {
    const { rowCount } = await db.query(
      'UPDATE informes SET informe = $1 WHERE id = $2',
      [titulo, id]
    );
    if (rowCount === 0) return res.status(404).json({ ok:false, msg:'Informe no encontrado' });
    return res.json({ ok:true, titulo });
  } catch (e) {
    console.error('❌ Error actualizando título:', e.message);
    return res.status(500).json({ ok:false });
  }
});

// routes/informes.js
router.get('/certificados', async (req, res) => {
  try {
    const [gruposRes, instrumentosRes] = await Promise.all([
      db.query('SELECT id, nombre FROM grupos ORDER BY nombre'),
      db.query('SELECT id, nombre FROM instrumentos ORDER BY nombre')
    ]);

    const q = req.query || {};
    res.render('informes_y_certificados', {
      title: 'Informes y Certificados',
      hero: false,
      grupos: gruposRes.rows,
      instrumentos: instrumentosRes.rows,
      grupo_id: q.grupo_id || '',
      instrumento_id: q.instrumento_id || '',
      fecha: q.fecha || '',
      fecha_fin: q.fecha_fin || '',
      sec_violin: q.sec_violin || ''   // ← default
    });
  } catch (err) {
    console.error('Error cargando certificados:', err);
    res.status(500).send('Error cargando certificados');
  }
});

// === INFORME DE HORAS (usando evento_asignaciones para cada alumno) ===
router.get('/horas', isAuthenticated, async (req, res) => {
  const fechaISO     = toISODate(req.query.fecha);
  const fechaFinISO  = toISODate(req.query.fecha_fin);
  const grupo        = req.query.grupo;        // '', 'todos' o id
  const instrumento  = req.query.instrumento;  // '', 'todos' o id

  // Construir rango temporal
  const fromParam = fechaISO    ? `${fechaISO} 00:00:00`   : null;
  const toParam   = fechaFinISO ? `${fechaFinISO} 23:59:59`: null;

  try {
    // Normaliza SIEMPRE 4 parámetros (aunque sean null)
    const fromParam       = fechaISO    ? `${fechaISO} 00:00:00`    : null;          // $1
    const toParam         = fechaFinISO ? `${fechaFinISO} 23:59:59` : null;          // $2
    const grupoParam      = (grupo && grupo !== 'todos' && grupo !== '') ? Number(grupo) : null;          // $3
    const instrumentoParam= (instrumento && instrumento !== 'todos' && instrumento !== '') ? Number(instrumento) : null; // $4
    const params = [fromParam, toParam, grupoParam, instrumentoParam];
  
    const sql = `
      WITH ea AS (
  SELECT
    asig.alumno_id AS alumno_id,
    ev.id          AS evento_id,
    ev.grupo_id    AS grupo_id,

    (
      ev.fecha_inicio::date
      + COALESCE(
          NULLIF(asig.hora_inicio::text,'')::time,
          NULLIF(ev.hora_inicio::text,'')::time,
          TIME '00:00'
        )
    )::timestamp AS start_ts,

    (
      ev.fecha_fin::date
      + COALESCE(
          NULLIF(asig.hora_fin::text,'')::time,
          NULLIF(ev.hora_fin::text,'')::time,
          TIME '23:59:59'
        )
    )::timestamp AS end_ts,

    -- ✅ Factor de baremo: si no hay baremo → 1.0 (100%)
    COALESCE(bm.porcentaje, 100)::numeric / 100.0 AS baremo_factor

  FROM evento_asignaciones asig
  JOIN eventos ev ON ev.id = asig.evento_id
  LEFT JOIN baremos bm ON bm.id = ev.baremo_id
),

base AS (
  SELECT
    ea.alumno_id,
    ea.evento_id,
    ea.grupo_id,

    -- ✅ Horas del evento ponderadas por baremo
    (EXTRACT(EPOCH FROM (ea.end_ts - ea.start_ts)) / 3600.0) * ea.baremo_factor AS horas_evento,

    -- ✅ Guardamos el factor para ponderar también minutos_perdidos
    ea.baremo_factor
  FROM ea
  WHERE
    ($1::timestamp IS NULL OR ea.start_ts >= $1::timestamp)
    AND ($2::timestamp IS NULL OR ea.end_ts   <= $2::timestamp)
    AND ($3::int       IS NULL OR ea.grupo_id  = $3::int)
),

agregados AS (
  SELECT
    b.alumno_id,

    -- ✅ Total de horas (denominador) ya ponderado
    SUM(b.horas_evento) AS total_horas,

    -- ✅ Asistidas ponderadas: horas_evento - minutos_perdidos (también ponderados)
    GREATEST(
      COALESCE(SUM(CASE
        WHEN asi.id IS NOT NULL AND asi.tipo IN ('manual','qr') THEN b.horas_evento
        ELSE 0
      END), 0)
      - COALESCE(SUM(CASE
        WHEN asi.id IS NOT NULL AND asi.tipo IN ('manual','qr') THEN (COALESCE(asi.minutos_perdidos,0) / 60.0) * b.baremo_factor
        ELSE 0
      END), 0),
      0
    ) AS horas_asistidas

  FROM base b
  JOIN alumnos a ON a.id = b.alumno_id AND a.activo = TRUE
  LEFT JOIN asistencias asi
         ON asi.alumno_id = b.alumno_id
        AND asi.evento_id = b.evento_id
  WHERE
    ($4::int IS NULL OR EXISTS (
      SELECT 1
      FROM alumno_instrumento ai
      WHERE ai.alumno_id = b.alumno_id
        AND ai.instrumento_id = $4::int
    ))
  GROUP BY b.alumno_id
  HAVING SUM(b.horas_evento) > 0
)

SELECT
  a.id                           AS alumno_id,
  a.nombre || ' ' || a.apellidos AS alumno,
  ROUND(ag.total_horas::numeric, 2)      AS total_horas,
  ROUND(ag.horas_asistidas::numeric, 2)  AS horas_asistidas,
  ROUND(
    CASE WHEN ag.total_horas > 0
         THEN (ag.horas_asistidas / ag.total_horas) * 100
         ELSE 0 END
    ::numeric, 1
  ) AS porcentaje_asistencia
FROM agregados ag
JOIN alumnos a ON a.id = ag.alumno_id
ORDER BY porcentaje_asistencia DESC, alumno;

    `;
  
    const result = await db.query(sql, params);
  
    // Lo que muestra la vista:
    // - "Horas" = horas_asistidas
    // - "% sobre total" = porcentaje_asistencia
    const resultados = result.rows.map(r => ({
      id: r.alumno_id,
      alumno: r.alumno,
      horas: Number(r.horas_asistidas).toFixed(2),
      porcentaje: Number(r.porcentaje_asistencia).toFixed(1)
    }));
  
    res.render('informes_horas', {
      fecha: fechaISO || '',
      fecha_fin: fechaFinISO || '',
      grupo,
      instrumento,
      resultados
    });
  
  } catch (err) {
    console.error('❌ Error calculando informe de horas (asignaciones):', err);
    res.status(500).send('Error calculando informe de horas');
  }
  
});

router.post('/horas/guardar', isAuthenticated, async (req, res) => {
  const { fecha, fecha_fin, grupo, instrumento, resultados } = req.body;
  const parsed = JSON.parse(resultados || '[]');

  const fISO = toISODate(fecha);
  const ffISO = toISODate(fecha_fin);

  const opts = { day: '2-digit', month: 'long', year: 'numeric' };
  const fi = fISO ? new Date(`${fISO}T00:00:00`).toLocaleDateString('es-ES', opts) : '';
  const ff = ffISO ? new Date(`${ffISO}T00:00:00`).toLocaleDateString('es-ES', opts) : null;

  const nombreInforme = `Porcentaje de horas de asistencia (${fi}` + (ff ? ` – ${ff}` : '') + `)`;

  try {
    // 1) Crear informe (guardo como fecha de informe el fin si existe, si no el inicio)
    const result = await db.query(`
      INSERT INTO informes (informe, grupo_id, instrumento_id, fecha)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [
      nombreInforme,
      (grupo === 'todos' || grupo === '' || grupo == null) ? null : parseInt(grupo, 10),
      (instrumento === 'todos' || instrumento === '' || instrumento == null) ? null : parseInt(instrumento, 10),
      ffISO || fISO || new Date().toISOString().slice(0, 10)
    ]);
    const informeId = result.rows[0].id;

    // 2) Campos
    const campoInsert = `
      INSERT INTO informe_campos (informe_id, nombre, tipo, obligatorio)
      VALUES ($1, $2, $3, false)
      RETURNING id
    `;
    const campoAlumno = (await db.query(campoInsert, [informeId, 'Alumno', 'numero'])).rows[0].id;
    const campoHoras = (await db.query(campoInsert, [informeId, 'Horas', 'numero'])).rows[0].id;
    const campoPorcentaje = (await db.query(campoInsert, [informeId, 'Porcentaje', 'numero'])).rows[0].id;

    // 3) Resultados
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
