// routes/atril.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');
const { toISODate } = require('../utils/fechas');

// Helpers comunes
const norm = (s) => String(s || '').trim();

function splitInstrumento(label) {
  const s = norm(label);
  const m = s.match(/^viol[ií]n\s*(i{1,2})$/i);
  if (m) return { base: 'Violín', seccion: (m[1].toUpperCase() === 'II' ? 'II' : 'I') };
  return { base: s, seccion: null };
}
function joinInstrumento(base, seccion) {
  if (!base) return '';
  if (/^viol[ií]n$/i.test(base) && (seccion === 'I' || seccion === 'II')) return `Violín ${seccion}`;
  return base;
}

// Inferencia ligera por si un alumno aún no tiene registro guardado.
// (Puedes adaptar estas consultas a tu esquema real)
async function inferInstrumentoActual(client, alumnoId) {
  // 1) instrumento asociado al alumno
  const rIns = await client.query(`
    SELECT ins.nombre
    FROM alumno_instrumento ai
    JOIN instrumentos ins ON ins.id = ai.instrumento_id
    WHERE ai.alumno_id = $1
    ORDER BY ins.nombre ASC
    LIMIT 1
  `, [alumnoId]);
  let base = norm(rIns.rows[0]?.nombre);

  // 2) si es Violín, intenta deducir sección por pertenencia a grupos “Violín I/II”
  if (/^viol[ií]n(\s|$)/i.test(base)) {
    const rSec = await client.query(`
      SELECT CASE
               WHEN g.nombre ~* '^viol[ií]n\\s*i(\\b|\\s|$)'  THEN 'Violín I'
               WHEN g.nombre ~* '^viol[ií]n\\s*ii(\\b|\\s|$)' THEN 'Violín II'
               ELSE NULL
             END AS sec
      FROM alumno_grupo ag
      JOIN grupos g ON g.id = ag.grupo_id
      WHERE ag.alumno_id = $1
        AND (
          g.nombre ~* '^viol[ií]n\\s*i(\\b|\\s|$)' OR
          g.nombre ~* '^viol[ií]n\\s*ii(\\b|\\s|$)'
        )
      ORDER BY CASE
                 WHEN g.nombre ~* '^viol[ií]n\\s*i'  THEN 1
                 WHEN g.nombre ~* '^viol[ií]n\\s*ii' THEN 2
                 ELSE 3
               END
      LIMIT 1
    `, [alumnoId]);
    base = rSec.rows[0]?.sec || 'Violín II'; // fallback
  }

  return base || 'Varios';
}

// --- REEMPLAZA desde aquí ---
router.get('/actual', async (req, res) => {
    const grupoId = Number(req.query.grupo_id);
    if (!Number.isInteger(grupoId)) return res.status(400).json({ error: 'grupo_id requerido' });
  
    const client = await db.connect();
    try {
      const hasSeccion = (await client.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='atril_clasificacion'
          AND column_name='instrumento_seccion'
        LIMIT 1
      `)).rowCount > 0;
  
      // Alumnos activos del grupo
      const { rows: alumnos } = await client.query(`
        SELECT 
          a.id AS alumno_id,
          TRIM(COALESCE(a.nombre,'') || ' ' || COALESCE(a.apellidos,'')) AS nombre
        FROM alumnos a
        JOIN alumno_grupo ag ON ag.alumno_id = a.id
        WHERE ag.grupo_id = $1
          AND COALESCE(a.activo, TRUE) = TRUE
        GROUP BY a.id, a.nombre, a.apellidos
        ORDER BY a.apellidos, a.nombre
      `, [grupoId]);
  
      const items = [];
      for (const a of alumnos) {
        // 1) Si hay algo guardado, úsalo SIEMPRE
        const q = hasSeccion ? `
          SELECT instrumento, instrumento_seccion, puesto
          FROM public.atril_clasificacion
          WHERE grupo_id = $1 AND alumno_id = $2
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        ` : `
          SELECT instrumento, NULL::text AS instrumento_seccion, puesto
          FROM public.atril_clasificacion
          WHERE grupo_id = $1 AND alumno_id = $2
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `;
        const row = (await client.query(q, [grupoId, a.alumno_id])).rows[0];
  
        let instrumento = null;
        let puesto = null;
  
        if (row) {
          instrumento = joinInstrumento(row.instrumento, row.instrumento_seccion);
          puesto = row.puesto ?? null;
        } else {
          // 2) Inferencia robusta (no dejar que explote)
          try {
            instrumento = await inferInstrumentoActual(client, a.alumno_id);
          } catch {
            instrumento = null; // si falla, seguimos sin romper la respuesta
          }
        }
  
        items.push({ alumno_id: a.alumno_id, nombre: a.nombre, instrumento, puesto });
      }
  
      // 3) Catálogo de instrumentos: usa lo detectado + fallback a tabla 'instrumentos'
      let instrumentos = [...new Set(items.map(x => x.instrumento).filter(Boolean))];
  
      if (!instrumentos.length) {
        try {
          const { rows: cat } = await client.query(`SELECT nombre FROM instrumentos ORDER BY nombre`);
          instrumentos = cat.map(r => r.nombre).filter(Boolean);
        } catch {
          // si tampoco hay catálogo, al menos ofrece Violín I/II para empezar
          instrumentos = ['Violín I', 'Violín II'];
        }
      } else {
        // Si hay “Violín” genérico (poco probable ya), expándelo a I/II
        if (instrumentos.some(x => /^viol[ií]n$/i.test(String(x)))) {
          instrumentos = instrumentos
            .filter(x => !/^viol[ií]n$/i.test(String(x)))
            .concat(['Violín I','Violín II']);
        }
      }
  
      // 4) Orden estable
      items.sort((x,y) =>
        String(x.instrumento||'').localeCompare(String(y.instrumento||''),'es',{numeric:true,sensitivity:'base'}) ||
        String(x.nombre||'').localeCompare(String(y.nombre||''),'es',{numeric:true,sensitivity:'base'})
      );
      instrumentos = instrumentos
        .map(s => String(s).trim())
        .filter(Boolean)
        .sort((a,b)=>a.localeCompare(b,'es',{numeric:true,sensitivity:'base'}));
  
      return res.json({ items, instrumentos });
    } catch (e) {
      console.error('[atril] GET /actual error:', e);
      // Último recurso: no rompas el cliente
      return res.json({ items: [], instrumentos: ['Violín I','Violín II'] });
    } finally {
      client.release();
    }
  });

// PUT /atril/actual[?dry=1][?instrumento=...]
// Body: { grupo_id, instrumento?, items: [{ alumno_id, instrumento, puesto }, ...] }
router.put('/actual', express.json(), async (req, res) => {
  const dry = req.query.dry === '1';
  const { grupo_id, instrumento, items } = req.body || {};
  const norm = s => String(s || '').trim();
  const grupoId = parseInt(grupo_id, 10);
  if (!Number.isInteger(grupoId) || grupoId <= 0)
    return res.status(400).json({ ok:false, error: 'grupo_id inválido' });
  if (!Array.isArray(items))
    return res.status(400).json({ ok:false, error: 'items debe ser un array' });

  // Si se pide explícitamente un instrumento, sólo ese
  const onlyInst = norm(instrumento ?? req.query.instrumento) || null;

  // Agrupar por instrumento (solo filas con puesto >= 1)
  const groups = new Map(); // instLabel -> [{alumno_id, puesto}]
  for (const it of items) {
    const inst = norm(it?.instrumento);
    const alumnoId = parseInt(it?.alumno_id, 10);
    const puesto   = parseInt(it?.puesto, 10);
    if (!inst || !Number.isInteger(alumnoId) || !Number.isInteger(puesto) || puesto < 1) continue;
    if (onlyInst && inst !== onlyInst) continue; // si se especificó uno, ignora el resto
    if (!groups.has(inst)) groups.set(inst, []);
    groups.get(inst).push({ alumno_id: alumnoId, puesto });
  }

  if (!groups.size) {
    const msg = onlyInst
      ? `No hay puestos válidos para el instrumento "${onlyInst}".`
      : 'No hay puestos válidos para guardar.';
    return res.status(400).json({ ok:false, error: msg });
  }

  // Validar duplicados dentro de cada instrumento
  const dupErrors = [];
  for (const [inst, arr] of groups.entries()) {
    const puestos = new Map();
    const alumnos = new Map();
    for (const r of arr) {
      puestos.set(r.puesto, (puestos.get(r.puesto)||0)+1);
      alumnos.set(r.alumno_id, (alumnos.get(r.alumno_id)||0)+1);
    }
    const dP = [...puestos.entries()].filter(([,c])=>c>1).map(([p])=>p);
    const dA = [...alumnos.entries()].filter(([,c])=>c>1).map(([a])=>a);
    if (dP.length) dupErrors.push(`Instrumento "${inst}": puestos duplicados ${dP.join(', ')}`);
    if (dA.length) dupErrors.push(`Instrumento "${inst}": alumnos duplicados ${dA.join(', ')}`);
  }
  if (dupErrors.length) return res.status(400).json({ ok:false, error: dupErrors.join(' | ') });

  const splitInstrumento = (label) => {
    const s = String(label || '').trim();
    const m = s.match(/^viol[ií]n\s*(i{1,2})$/i);
    if (m) return { base: 'Violín', seccion: (m[1].toUpperCase() === 'II' ? 'II' : 'I') };
    return { base: s, seccion: null };
  };

  const client = await db.connect();
  try {
    const hasSeccion = (await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='atril_clasificacion'
        AND column_name='instrumento_seccion'
      LIMIT 1
    `)).rowCount > 0;

    if (dry) {
      const targets = [];
      for (const [inst, arr] of groups.entries()) {
        const t = hasSeccion ? splitInstrumento(inst) : { base: inst, seccion: null };
        targets.push({ instrumento: inst, target: t, count: arr.length });
      }
      return res.json({ ok:true, dry:true, grupo_id: grupoId, hasSeccion, targets });
    }

    await client.query('BEGIN');

    const results = [];
    for (const [inst, arr] of groups.entries()) {
      const t = hasSeccion ? splitInstrumento(inst) : { base: inst, seccion: null };

      // DELETE del instrumento (y sección) objetivo
      if (hasSeccion) {
        await client.query(`
          DELETE FROM public.atril_clasificacion
          WHERE grupo_id=$1 AND instrumento=$2
            AND (instrumento_seccion IS NOT DISTINCT FROM $3)
        `, [grupoId, t.base, t.seccion]);
      } else {
        await client.query(`
          DELETE FROM public.atril_clasificacion
          WHERE grupo_id=$1 AND instrumento=$2
        `, [grupoId, t.base]);
      }

      // INSERT masivo usando FROM unnest(...)
      const alumnoIds = arr.map(r => r.alumno_id);
      const puestosArr= arr.map(r => r.puesto);
      if (hasSeccion) {
        await client.query(`
          INSERT INTO public.atril_clasificacion (grupo_id, instrumento, instrumento_seccion, alumno_id, puesto)
          SELECT $1, $2, $3, t.alumno_id, t.puesto
          FROM unnest($4::int[], $5::int[]) AS t(alumno_id, puesto)
        `, [grupoId, t.base, t.seccion, alumnoIds, puestosArr]);
      } else {
        await client.query(`
          INSERT INTO public.atril_clasificacion (grupo_id, instrumento, alumno_id, puesto)
          SELECT $1, $2, t.alumno_id, t.puesto
          FROM unnest($3::int[], $4::int[]) AS t(alumno_id, puesto)
        `, [grupoId, t.base, alumnoIds, puestosArr]);
      }

      results.push({ instrumento: inst, saved: arr.length, target: t });
    }

    await client.query('COMMIT');
    return res.json({ ok:true, grupo_id: grupoId, savedByInstrument: results });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ ok:false, error: 'Puesto duplicado en ese instrumento/sección.' });
    if (e.code === '23503') return res.status(400).json({ ok:false, error: 'grupo_id o alumno_id no existen (FK).' });
    if (e.code === '42P01') return res.status(500).json({ ok:false, error: 'La tabla atril_clasificacion no existe.' });
    if (e.code === '42703') return res.status(500).json({ ok:false, error: 'Columna desconocida en atril_clasificacion (¿instrumento_seccion?).' });
    return res.status(500).json({ ok:false, error: e.detail || e.message || 'Error guardando la clasificación' });
  } finally {
    client.release();
  }
});

// GET /atril/actual/editor?grupo_id=123
router.get('/actual/editor', async (req, res) => {
  const grupoId = parseInt(req.query.grupo_id, 10);
  const client = await db.connect();
  try {
    let grupoNombre = '';
    if (Number.isInteger(grupoId)) {
      const r = await client.query(`SELECT nombre FROM grupos WHERE id=$1`, [grupoId]);
      grupoNombre = (r.rows[0]?.nombre || '').trim();
    }

    res.render('atril_clasificacion_actual', {
      title: 'Clasificación de atril (actual)',
      hero: false,
      grupo_id: grupoId || '',
      grupo_nombre: grupoNombre || '',
      // Base configurable para tu nuevo editor de planos:
      plano_base: '/planos'  // <-- cambia aquí si tu ruta real es otra
    });
  } catch (e) {
    console.error('[atril] render editor error:', e);
    res.status(500).send('Error cargando el editor');
  } finally {
    client.release();
  }
});


module.exports = router;
