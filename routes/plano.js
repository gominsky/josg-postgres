// routes/plano.js
const express = require('express');
const router = express.Router();
const pool = require('../database/db');
const sharp = require('sharp'); // fallback PNG
const { isAuthenticated } = require('../middleware/auth');
const {
  FONT_STACK, esc, svgToPdfBuffer, renderMsg,
  colorPorInstrumento, autoLayoutFromCounts, buildLegendFromPositions,
  // ↓ extras (con fallback inline por si aún no están en utils)
  abbreviateName = (full = '', { max = 16 } = {}) => {
    const s = String(full).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= max) return s;
    const parts = s.split(' ');
    if (parts.length >= 2) {
      const first = parts[0], last = parts[parts.length - 1];
      const v1 = `${first[0]}. ${last}`;
      if (v1.length <= max) return v1;
      const v2 = `${first[0]}. ${last[0]}.`;
      if (v2.length <= max) return v2;
    }
    return s.slice(0, Math.max(3, max - 1)) + '…';
  },
  stageBackdropSVG = (W, H) => {
    const x1 = W * 0.06, x2 = W * 0.94, y = H * 0.72;
    const rx = W * 0.52, ry = H * 0.86;
    return `
      <path d="M ${x1} ${y}
               A ${rx} ${ry} 0 0 1 ${x2} ${y}
               L ${x2} ${H} L ${x1} ${H} Z"
            fill="#EAE6DF" fill-opacity="0.35"></path>`;
  },
  directorPodiumSVG = (cx, cy) => {
    const w = 64, h = 8, r = 2;
    return `<rect x="${cx - w/2}" y="${cy + 22}" width="${w}" height="${h}" rx="${r}" ry="${r}"
                  fill="#CFCFCF" fill-opacity="0.6"></rect>`;
  },
} = require('../utils/planoUtils');
// helper no-cache
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}
function atrilLadoFromIndex(i) {
  const n = Math.max(0, i|0);
  return { atril: Math.floor(n/2) + 1, lado: (n % 2) + 1 }; // lado: 1→I, 2→II
}

function mapSeccionToSpec(seccionRaw) {
  const seccion = (seccionRaw || '').trim();
  const low = seccion.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  if (low.startsWith('violin i')) {
    return { baseInstrumento: 'Violín', grupoSeccion: 'Violín I', rankingInstrumento: 'Violín' };
  }
  if (low.startsWith('violin ii')) {
    return { baseInstrumento: 'Violín', grupoSeccion: 'Violín II', rankingInstrumento: 'Violín' };
  }
  return { baseInstrumento: seccion, grupoSeccion: null, rankingInstrumento: seccion };
}

async function fetchCandidatosOrdenados(client, grupoOrquesta, seccionLayout) {
  const spec = mapSeccionToSpec(seccionLayout);
  const sql = `
    WITH base AS (
      SELECT DISTINCT
        a.id,
        a.apellidos, a.nombre
      FROM alumnos a
      JOIN alumno_instrumento ai   ON ai.alumno_id = a.id
      JOIN instrumentos      inst  ON inst.id      = ai.instrumento_id
      JOIN alumno_grupo      ag_or ON ag_or.alumno_id = a.id
      JOIN grupos            g_or  ON g_or.id         = ag_or.grupo_id
      LEFT JOIN alumno_grupo ag_sec ON ag_sec.alumno_id = a.id
      LEFT JOIN grupos       g_sec  ON g_sec.id         = ag_sec.grupo_id
      WHERE a.activo = TRUE
        AND g_or.nombre = $1
        AND inst.nombre ILIKE $2
        AND ( $3::text IS NULL OR g_sec.nombre = $3 )
    ),
    ult AS (
      SELECT DISTINCT ON (b.id)
        b.id,
        pr.puntuacion::numeric   AS puntuacion,
        pr.asistencia::boolean   AS asistencia,
        pr.trimestre
      FROM base b
      LEFT JOIN pruebas_atril_norm pr
        ON pr.alumno_id::int = b.id
       AND pr.grupo = $1
       AND pr.instrumento ILIKE $4
      ORDER BY b.id, pr.trimestre DESC NULLS LAST
    )
    SELECT
      b.id,
      b.apellidos, b.nombre,
      u.puntuacion, u.asistencia
    FROM base b
    LEFT JOIN ult u ON u.id = b.id
    ORDER BY
      (u.puntuacion IS NOT NULL) DESC,
      u.puntuacion DESC NULLS LAST,
      b.apellidos ASC, b.nombre ASC
  `;
  const params = [
    grupoOrquesta,                  // $1
    spec.baseInstrumento,           // $2
    spec.grupoSeccion,              // $3
    spec.rankingInstrumento         // $4
  ];

  const { rows } = await client.query(sql, params);
  return rows;
}

async function fetchLayout(client, layoutId) {
  const { rows } = await client.query(
    `SELECT id, instrumento, atril, puesto, x, y, angulo
       FROM layout_posiciones
      WHERE layout_id = $1
      ORDER BY instrumento, atril, puesto`,
    [layoutId]
  );
  const secciones = [...new Set(rows.map(r => r.instrumento))];
  return { posiciones: rows, secciones };
}
/* ========== Helpers de layout guardado ========== */
async function getSavedLayout({ scope, scope_id }) {
  try {
    const { rows } = await pool.query(
      `SELECT key, x, y, angle
         FROM plano_layout
        WHERE scope = $1 AND scope_id = $2
        ORDER BY key`,
      [String(scope), String(scope_id)]
    );
    return rows.length ? { items: rows } : null;
  } catch (e) {
    console.warn('[plano] getSavedLayout error:', e.message);
    return null;
  }
}

router.get('/evento/:eventoId.:ext', async (req, res) => {
  const { eventoId } = req.params;
  const ext = String(req.params.ext || '').toLowerCase();
  if (!new Set(['svg','png','pdf']).has(ext)) return res.status(404).send('Extensión no soportada');

  // Sin caché
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  // helper: índice 0→(atril 1,lado1), 1→(1,2), 2→(2,1)...
  const atrilLadoFromIndex = (i) => ({ atril: Math.floor((i|0)/2)+1, lado: ((i|0)%2)+1 });

  try {
    /* 1) Evento (incluye grupo_id) */
    const { rows: evRows } = await pool.query(
      `SELECT e.id, e.titulo, e.fecha_inicio, e.grupo_id, g.nombre AS grupo_nombre
         FROM eventos e
         LEFT JOIN grupos g ON g.id = e.grupo_id
        WHERE e.id = $1`,
      [eventoId]
    );
    if (!evRows.length) {
      const { type, buf } = await renderMsg(ext, `Evento #${eventoId}`, 'Evento no encontrado.');
      return res.type(type).send(buf);
    }
    const evento  = evRows[0];
    const grupoId = evento.grupo_id != null ? Number(evento.grupo_id) : null;

    /* 2) Asignados al evento (con fallback de instrumento “principal”) */
    const { rows: asignados } = await pool.query(`
      SELECT
        ea.alumno_id,
        TRIM(COALESCE(a.nombre,'') || ' ' || COALESCE(a.apellidos,'')) AS nombre,
        COALESCE(
          NULLIF(TRIM(ea.instrumento), ''),
          (
            SELECT ins.nombre
            FROM alumno_instrumento ai
            JOIN instrumentos ins ON ins.id = ai.instrumento_id
            WHERE ai.alumno_id = ea.alumno_id
            ORDER BY ins.nombre ASC
            LIMIT 1
          ),
          'Varios'
        ) AS instrumento
      FROM evento_asignaciones ea
      JOIN alumnos a ON a.id = ea.alumno_id
      WHERE ea.evento_id = $1
    `, [eventoId]);

    if (!asignados.length) {
      const { type, buf } = await renderMsg(ext, `Evento #${eventoId}`, 'No hay asignaciones para este evento.');
      return res.type(type).send(buf);
    }

    // IDs de alumnos asignados
    const idList = asignados.map(r => Number(r.alumno_id)).filter(Number.isFinite);
    const idArr  = idList.length ? idList : [-1];

    /* 3) Clasificación del grupo (si hay grupo) — public.atril_clasificacion */
    let clasifMap = new Map(); // alumno_id -> { instrumentoClasif, puesto }
    if (Number.isInteger(grupoId)) {
      // ¿existe instrumento_seccion?
      const colChk = await pool.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='atril_clasificacion' AND column_name='instrumento_seccion'
        LIMIT 1
      `);
      const hasSeccion = colChk.rowCount > 0;

      const { rows: clasifRows } = await pool.query(
        `
        SELECT
          ac.alumno_id,
          -- Mapeo Violín + seccion -> 'Violín I/II'
          CASE
            WHEN ac.instrumento ~* '^viol[ií]n$' AND ${hasSeccion ? `ac.instrumento_seccion IN ('I','II')` : 'FALSE'}
              THEN 'Violín ' || ac.instrumento_seccion
            ELSE ac.instrumento
          END AS instrumento_clasif,
          ac.puesto
        FROM public.atril_clasificacion ac
        WHERE ac.grupo_id = $1
          AND ac.alumno_id = ANY($2::int[])
        `,
        [grupoId, idArr]
      );
      clasifMap = new Map(
        clasifRows
          .filter(r => r.alumno_id != null && r.instrumento_clasif && Number.isFinite(Number(r.puesto)))
          .map(r => [Number(r.alumno_id), { instrumento: String(r.instrumento_clasif).trim(), puesto: Number(r.puesto) }])
      );
    }

    /* 4) Deducción de sección de Violín por pertenencia a grupos (para los que no tienen clasif) */
    const secMap = new Map(); // alumno_id -> 'Violín I'|'Violín II'|null
    {
      const { rows: secRows } = await pool.query(
        `
        WITH sec AS (
          SELECT DISTINCT ON (ag.alumno_id)
                 ag.alumno_id,
                 CASE
                   WHEN g.nombre ~* '^viol[ií]n\\s*i(\\b|\\s|$)'  THEN 'Violín I'
                   WHEN g.nombre ~* '^viol[ií]n\\s*ii(\\b|\\s|$)' THEN 'Violín II'
                   ELSE NULL
                 END AS sec
          FROM alumno_grupo ag
          JOIN grupos g ON g.id = ag.grupo_id
          WHERE ag.alumno_id = ANY($1::int[])
            AND (g.nombre ~* '^viol[ií]n\\s*i(\\b|\\s|$)' OR g.nombre ~* '^viol[ií]n\\s*ii(\\b|\\s|$)')
          ORDER BY ag.alumno_id,
                   CASE
                     WHEN g.nombre ~* '^viol[ií]n\\s*i'  THEN 1
                     WHEN g.nombre ~* '^viol[ií]n\\s*ii' THEN 2
                     ELSE 3
                   END
        )
        SELECT * FROM sec
        `,
        [idArr]
      );
      for (const r of secRows) secMap.set(Number(r.alumno_id), r.sec);
    }

    /* 5) Construir lista por instrumento:
          - Si hay clasificación: instrumento y orden por ac.puesto (hasRanking = true)
          - Si no hay: instrumento de asignación; si es "Violín" a secas → intentar secMap; hasRanking = false
       */
    const porInstrumento = new Map(); // inst -> [{alumno_id, nombre, hasRanking, puesto, instrumento}]
    for (const a of asignados) {
      const alumnoId = Number(a.alumno_id);
      const nombre   = a.nombre;
      const instEv   = String(a.instrumento || '').trim();

      const clasif = clasifMap.get(alumnoId);
      let instFinal, hasRanking = false, puesto = null;

      if (clasif) {
        instFinal  = clasif.instrumento || instEv || 'Varios';
        hasRanking = true;
        puesto     = clasif.puesto;
      } else {
        if (/^viol[ií]n$/i.test(instEv)) {
          instFinal = secMap.get(alumnoId) || 'Violín'; // si hay sección, úsala; si no, queda “Violín”
        } else {
          instFinal = instEv || 'Varios';
        }
      }

      if (!porInstrumento.has(instFinal)) porInstrumento.set(instFinal, []);
      porInstrumento.get(instFinal).push({
        instrumento: instFinal,
        alumno_id: alumnoId,
        nombre,
        hasRanking,
        puesto // solo si hasRanking
      });
    }

    // (Opcional) filtro por instrumentos ?inst=CSV
    const instCSV = String(req.query.inst || '').trim();
    if (instCSV) {
      const filtro = new Set(instCSV.split(',').map(s => s.trim()).filter(Boolean));
      for (const key of [...porInstrumento.keys()]) {
        if (!filtro.has(key)) porInstrumento.delete(key);
      }
      if (!porInstrumento.size) {
        const { type, buf } = await renderMsg(ext, `Evento #${eventoId}`, 'No hay instrumentos tras aplicar el filtro.');
        return res.type(type).send(buf);
      }
    }

    /* 6) Conteos → layout base */
    const counts = {};
    for (const [inst, lista] of porInstrumento.entries()) counts[inst] = (counts[inst] || 0) + lista.length;
    const posiciones = autoLayoutFromCounts(counts); // { instrumento, atril, puesto(1/2), x, y, angulo }

    /* 7) Asignación a plazas
          Orden por instrumento: primero con ranking (ordenados por puesto ASC),
          luego sin ranking (alfabético por nombre). Después calculamos atril/lado por índice.
    */
    const asignacion = new Map();

    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const base = (porInstrumento.get(inst) || []);

      const ranked = base
        .filter(x => x.hasRanking)
        .sort((a,b) => (a.puesto || 1) - (b.puesto || 1) ||
                       String(a.alumno_id).localeCompare(String(b.alumno_id), 'es', { numeric:true }));

      const rest = base
        .filter(x => !x.hasRanking)
        .sort((a,b) =>
          (a.nombre||'').localeCompare(b.nombre||'', 'es', { sensitivity:'base' }) ||
          String(a.alumno_id).localeCompare(String(b.alumno_id), 'es', { numeric:true })
        );

      const ordered = ranked.concat(rest);
      const lista   = ordered.map((c,i) => ({ ...c, ...atrilLadoFromIndex(i) })); // añade {atril,lado}

      const plazas = posiciones
        .filter(p => p.instrumento === inst)
        .sort((a,b) => a.atril - b.atril || a.puesto - b.puesto);

      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand  = lista[i]; // { instrumento, alumno_id, nombre, atril, lado, hasRanking, puesto? }
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    /* 8) Cargar layout guardado: evento → grupo (fallback) */
    const savedEvento = await getSavedLayout({ scope: 'evento', scope_id: String(eventoId) });
    const savedGrupo  = Number.isInteger(grupoId) ? await getSavedLayout({ scope: 'grupo', scope_id: String(grupoId) }) : null;
    const saved       = savedEvento || savedGrupo;
    const L = new Map((saved?.items || []).map(it => [it.key, it])); // key = "Inst|atril|lado"

    /* 9) Render SVG */
    const W = 1400, H = 900, FONT = FONT_STACK;

    let nodos = '';
    for (const p of posiciones) {
      const key  = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue;

      // Posición: guardada (normalizada 0–1) o auto
      const s   = L.get(key);
      const cx  = (s ? s.x : p.x) * W;
      const cy  = (s ? s.y : p.y) * H;
      const ang = (s && Number.isFinite(s.angle)) ? s.angle : p.angulo;

      const color = colorPorInstrumento(p.instrumento);

      // Nombre corto: nombre + primer apellido si hay dos
      const parts = (asig.nombre || '').trim().split(/\s+/);
      const displayName = parts.length >= 3 ? `${parts[0]} ${parts[1]}` : (asig.nombre || asig.alumno_id);

      // Nº de atril / Lado SIEMPRE desde el candidato (no usar "seat" ni ranking)
      const numAtril = Number(asig.atril) || p.atril || 1;
      const ladoTxt  = (Number(asig.lado) === 1 ? 'I' : 'II');

      nodos += `
        <g class="draggable" data-key="${esc(key)}"
           transform="translate(${cx},${cy}) rotate(${ang})">
          <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
          <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
          <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>

          <text y="4" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT}">
            ${numAtril}
          </text>
          <text y="22" text-anchor="middle" font-size="10" fill="#fff" fill-opacity="0.95" font-family="${FONT}">
            ${ladoTxt}
          </text>

          <text y="46" text-anchor="middle" font-size="9" fill="#333" font-family="${FONT}">
            ${esc(displayName)}
          </text>
        </g>`;
    }

    const cxDir = W / 2, cyDirBase = H - 50;
    const director = `
      <g aria-label="Director">
        ${directorPodiumSVG(W / 2, H - 50)}
        <circle cx="${cxDir}" cy="${cyDirBase}" r="20" fill="#000"></circle>
        <circle cx="${cxDir}" cy="${cyDirBase}" r="22" fill="none" stroke="#fff" stroke-width="2"></circle>
        <text x="${cxDir}" y="${cyDirBase + 34}" text-anchor="middle" font-size="12" fill="#000" font-family="${FONT}">Director</text>
      </g>`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#FAF8F5"></rect>
        ${stageBackdropSVG(W, H)}
        <text x="${W/2}" y="36" text-anchor="middle" font-size="24" font-weight="800" letter-spacing=".3px" font-family="${FONT}">
          Plano de ${esc(evento.titulo || 'Evento')}${evento.grupo_nombre ? ' — ' + esc(evento.grupo_nombre) : ''}
        </text>
        ${buildLegendFromPositions({ posiciones, x: 16, y: 16, fontFamily: FONT })}
        ${nodos}
        ${director}
      </svg>`;

    // 10) Respuesta
    if (ext === 'svg') return res.type('image/svg+xml; charset=utf-8').send(svg);
    if (ext === 'pdf') {
      try {
        const pdfBuf = await svgToPdfBuffer(svg, { W, H, title: `Plano ${evento.titulo || 'Evento'}` });
        return res.type('application/pdf').send(pdfBuf);
      } catch {
        const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
        return res.type('image/png').send(png);
      }
    }
    const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error('❌ Error plano evento:', e);
    return res.status(500).send('Error generando el plano del evento');
  }
});

router.get('/clasif/:grupo.:ext', async (req, res) => {
  const { grupo: grupoParam } = req.params;
  const ext = String(req.params.ext || '').toLowerCase();
  if (!new Set(['svg','png','pdf']).has(ext)) return res.status(404).send('Extensión no soportada');
  noCache(res);

  // helper local: índice 0→(atril 1,lado1), 1→(1,2), 2→(2,1)...
  function atrilLadoFromIndex(i) {
    const n = Math.max(0, i | 0);
    return { atril: Math.floor(n/2) + 1, lado: (n % 2) + 1 };
  }

  try {
    // 1) Resolver grupo (permite id numérico o nombre)
    let grupoId = null, grupoNombre = null;
    if (/^\d+$/.test(grupoParam)) {
      const r = await pool.query(`SELECT id, nombre FROM grupos WHERE id=$1::int`, [grupoParam]);
      if (!r.rowCount) return res.status(404).send('Grupo no encontrado');
      grupoId = r.rows[0].id; grupoNombre = r.rows[0].nombre;
    } else {
      const r = await pool.query(`SELECT id, nombre FROM grupos WHERE nombre=$1`, [grupoParam]);
      if (!r.rowCount) return res.status(404).send('Grupo no encontrado');
      grupoId = r.rows[0].id; grupoNombre = r.rows[0].nombre;
    }

    // 2) Filtro opcional de instrumentos (?inst=Violín%20I,Clarinete)
    const rawInst = (req.query.inst || '').toString().trim();
    const instFiltro = rawInst
      ? new Set(rawInst.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    // 3) ¿existe columna instrumento_seccion?
    const colChk = await pool.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='atril_clasificacion' AND column_name='instrumento_seccion'
      LIMIT 1
    `);
    const hasSeccion = colChk.rowCount > 0;

    // 4) Cargar clasificación del grupo
    let sql, params = [grupoId];
    if (hasSeccion) {
      sql = `
        SELECT
          CASE WHEN ac.instrumento ~* '^viol[ií]n$' AND ac.instrumento_seccion IN ('I','II')
               THEN 'Violín ' || ac.instrumento_seccion
               ELSE ac.instrumento
          END AS instrumento,
          ac.alumno_id,
          ac.puesto,
          TRIM(COALESCE(a.nombre,'') || ' ' || COALESCE(a.apellidos,'')) AS nombre
        FROM public.atril_clasificacion ac
        JOIN public.alumnos a ON a.id = ac.alumno_id
        WHERE ac.grupo_id = $1
      `;
    } else {
      sql = `
        SELECT
          ac.instrumento AS instrumento,
          ac.alumno_id,
          ac.puesto,
          TRIM(COALESCE(a.nombre,'') || ' ' || COALESCE(a.apellidos,'')) AS nombre
        FROM public.atril_clasificacion ac
        JOIN public.alumnos a ON a.id = ac.alumno_id
        WHERE ac.grupo_id = $1
      `;
    }

    const { rows: clasifRaw } = await pool.query(sql, params);

    // Normalizar / filtrar / ordenar: por instrumento + puesto asc + alumno_id
    let clasif = clasifRaw
      .map(r => ({
        instrumento: String(r.instrumento || '').trim(),
        alumno_id: r.alumno_id,
        puesto: Number(r.puesto),
        nombre: r.nombre || ''
      }))
      .filter(r => r.instrumento && Number.isInteger(r.puesto) && r.puesto >= 1);

    if (instFiltro) {
      clasif = clasif.filter(r => instFiltro.has(r.instrumento));
    }

    if (!clasif.length) {
      const { type, buf } = await renderMsg(ext,
        `No hay clasificación para ${grupoNombre}.`,
        `Revisa la tabla atril_clasificacion del grupo.`);
      return res.type(type).send(buf);
    }

    clasif.sort((a,b) =>
      a.instrumento.localeCompare(b.instrumento,'es',{sensitivity:'base'}) ||
      a.puesto - b.puesto ||
      (a.alumno_id - b.alumno_id)
    );

    // 5) Conteos por instrumento -> layout
    const counts = {};
    for (const r of clasif) counts[r.instrumento] = (counts[r.instrumento] || 0) + 1;
    const posiciones = autoLayoutFromCounts(counts); // ← helper existente: { instrumento, atril, puesto(1/2), x, y, angulo }

    // 6) Agrupar candidatos por instrumento
    const porInstrumento = new Map();
    for (const r of clasif) {
      if (!porInstrumento.has(r.instrumento)) porInstrumento.set(r.instrumento, []);
      porInstrumento.get(r.instrumento).push(r);
    }

    // 7) Asignar candidatos a plazas (emparejando 1–2, 3–4… con ATRIL/LADO por índice)
    const asignacion = new Map();

    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const base = (porInstrumento.get(inst) || []).slice()
        .sort((a,b) => a.puesto - b.puesto || (a.alumno_id - b.alumno_id)); // 1,2,3…

      const lista = base.map((c, i) => ({ ...c, clasif: c.puesto, ...atrilLadoFromIndex(i) }));

      const plazas = posiciones
        .filter(p => p.instrumento === inst)
        .sort((a,b) => a.atril - b.atril || a.puesto - b.puesto);

      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand  = lista[i]; // { instrumento, alumno_id, nombre, clasif, atril, lado }
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    // 8) Aplicar layout guardado (si existe) de scope=grupo
    const { rows: saved } = await pool.query(`
      SELECT key, x, y, angle
      FROM public.plano_layout
      WHERE scope='grupo' AND scope_id=$1
    `, [grupoId]);
    const savedByKey = new Map(saved.map(r => [r.key, r]));
    for (const p of posiciones) {
      const k = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const s = savedByKey.get(k);
      if (s) { p.x = s.x; p.y = s.y; p.angulo = s.angle; }
    }

    // 9) Render SVG
    const W = 1400, H = 900, FONT = FONT_STACK;
    let nodos = '';
    for (const p of posiciones) {
      const key  = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue;

      const cx = p.x * W, cy = p.y * H;
      const color = colorPorInstrumento(p.instrumento);

      // Nombre corto
      const parts = (asig.nombre || '').trim().split(/\s+/);
      const displayName = parts.length >= 3 ? `${parts[0]} ${parts[1]}` : (asig.nombre || asig.alumno_id);

      // ATRIL y LADO SIEMPRE desde la asignación; fallback a plaza o a la clasificación
      const numAtril = Number.isFinite(asig.atril)
        ? asig.atril
        : (Number.isFinite(p.atril) ? p.atril : Math.max(1, Math.ceil((asig.clasif || 1) / 2)));

      const ladoNum = Number.isFinite(asig.lado) ? asig.lado : (Number(p.puesto) === 1 ? 1 : 2);
      const ladoTxt = (ladoNum === 1 ? 'I' : 'II');

      nodos += `
        <g class="draggable" data-key="${esc(key)}"
           transform="translate(${cx},${cy}) rotate(${p.angulo})">
          <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
          <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
          <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>

          <!-- ATRIL grande -->
          <text y="4" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT}">
            ${numAtril}
          </text>

          <!-- LADO I/II -->
          <text y="22" text-anchor="middle" font-size="10" fill="#fff" fill-opacity="0.95" font-family="${FONT}">
            ${ladoTxt}
          </text>

          <!-- Nombre -->
          <text y="46" text-anchor="middle" font-size="9" fill="#333" font-family="${FONT}">
            ${esc(displayName)}
          </text>
        </g>`;
    }

    const cxDir = W/2, cyDirBase = H - 50;
    const director = `
      <g aria-label="Director">
        ${directorPodiumSVG(W/2, H-50)}
        <circle cx="${cxDir}" cy="${cyDirBase}" r="20" fill="#000"></circle>
        <circle cx="${cxDir}" cy="${cyDirBase}" r="22" fill="none" stroke="#fff" stroke-width="2"></circle>
        <text x="${cxDir}" y="${cyDirBase + 34}" text-anchor="middle" font-size="12" fill="#000" font-family="${FONT}">Director</text>
      </g>`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#FAF8F5"></rect>
        ${stageBackdropSVG(W, H)}
        <text x="${W/2}" y="36" text-anchor="middle" font-size="24" font-weight="800" letter-spacing=".3px" font-family="${FONT}">
          Plano · ${esc(grupoNombre)}
        </text>
        ${buildLegendFromPositions({ posiciones, x: 16, y: 16, fontFamily: FONT })}
        ${nodos}
        ${director}
      </svg>`;

    // 10) Salida
    if (ext === 'svg') return res.type('image/svg+xml; charset=utf-8').send(svg);
    if (ext === 'pdf') {
      try {
        const pdfBuf = await svgToPdfBuffer(svg, { W, H, title: `Plano ${grupoNombre}` });
        return res.type('application/pdf').send(pdfBuf);
      } catch (e) {
        const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
        return res.type('image/png').send(png);
      }
    }
    const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error('[plano] GET /clasif/:grupo.:ext error:', e);
    return res.status(500).send('Error generando el plano.');
  }
});

router.get('/latest/:grupo.:ext', async (req, res) => {
  const { grupo: grupoParam } = req.params;
  const ext = String(req.params.ext || '').toLowerCase();
  if (!new Set(['svg','png','pdf']).has(ext)) return res.status(404).send('Extensión no soportada');

  noCache(res);

  try {
    // Resolver nombre si llega ID
    let grupoNombre = grupoParam;
    if (/^\d+$/.test(grupoParam)) {
      const { rows: g } = await pool.query(`SELECT nombre FROM grupos WHERE id = $1::int`, [grupoParam]);
      if (!g.length) return res.status(404).send('Grupo no encontrado');
      grupoNombre = g[0].nombre;
    }

    // Último por instrumento (mapeando violín → Violín I/II según grupo del alumno)
    const { rows: ranking } = await pool.query(`
      WITH base AS (
        SELECT instrumento, alumno_id, puntuacion, asistencia, trimestre
        FROM pruebas_atril_norm
        WHERE grupo = $1
          AND asistencia = TRUE
          AND trimestre ~ '^[0-9]{2}/[0-9]{2}T[1-4]$'
      ),
      parsed AS (
        SELECT *,
               (regexp_match(trimestre, '^([0-9]{2})/([0-9]{2})T([1-4])$'))[2]::int AS year_end,
               (regexp_match(trimestre, 'T([1-4])$'))[1]::int AS t
        FROM base
      ),
      latest AS (
        SELECT DISTINCT ON (instrumento) instrumento, trimestre
        FROM parsed
        ORDER BY instrumento, year_end DESC, t DESC
      )
      SELECT
        CASE
          WHEN regexp_replace(p.instrumento, '\\s+I{1,2}$', '', 'i') ~* '^viol[ií]n$' THEN
            COALESCE(
              (
                SELECT g.nombre
                FROM alumno_grupo ag
                JOIN grupos g ON g.id = ag.grupo_id
                WHERE ag.alumno_id = a.id
                  AND (
                    g.nombre ~* '^viol[ií]n\\s*i$' OR
                    g.nombre ~* '^viol[ií]n\\s*ii$'
                  )
                ORDER BY
                  CASE
                    WHEN g.nombre ~* '^viol[ií]n\\s*i$'  THEN 1
                    WHEN g.nombre ~* '^viol[ií]n\\s*ii$' THEN 2
                    ELSE 3
                  END
                LIMIT 1
              ),
              'Violín II'
            )
          ELSE p.instrumento
        END AS instrumento,
        p.alumno_id::text AS alumno_id,
        p.puntuacion,
        l.trimestre AS trimestre,
        TRIM(COALESCE(a.nombre,'') || ' ' || COALESCE(a.apellidos,'')) AS nombre
      FROM parsed p
      JOIN latest l
        ON p.instrumento = l.instrumento AND p.trimestre = l.trimestre
      LEFT JOIN alumnos a
        ON a.id::text = TRIM(p.alumno_id)
      ORDER BY instrumento, p.puntuacion DESC, p.alumno_id ASC
    `, [grupoNombre]);

    if (!ranking.length) {
      const { type, buf } = await renderMsg(ext, `No hay datos recientes para ${grupoNombre}.`,
        `Asegúrate de que existan registros con asistencia en pruebas de atril.`);
      return res.type(type).send(buf);
    }

    // Conteos → layout automático
    const counts = {};
    for (const r of ranking) counts[r.instrumento] = (counts[r.instrumento] || 0) + 1;
    const posiciones = autoLayoutFromCounts(counts);

    // Agrupar por instrumento
    const porInstrumento = new Map();
    for (const r of ranking) {
      if (!porInstrumento.has(r.instrumento)) porInstrumento.set(r.instrumento, []);
      porInstrumento.get(r.instrumento).push(r);
    }

    // Asignación (orden por puntuación)
    const asignacion = new Map();
    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const lista = porInstrumento.get(inst) || [];
      const plazas = posiciones
        .filter(p => p.instrumento === inst)
        .sort((a,b) => a.atril - b.atril || a.puesto - b.puesto);
      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand = { ...lista[i], seat: i + 1 };
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    // Render
    // Render
const W = 1400, H = 900, FONT = FONT_STACK;

let nodos = '';
for (const p of posiciones) {
  const key  = `${p.instrumento}|${p.atril}|${p.puesto}`;
  const asig = asignacion.get(key);
  if (!asig) continue;

  const cx = p.x * W, cy = p.y * H;
  const color = colorPorInstrumento(p.instrumento);

  // Nombre corto
  const fullName = asig.nombre || asig.alumno_id || '';
  const parts = fullName.trim().split(/\s+/);
  const displayName = (parts.length >= 3) ? `${parts[0]} ${parts[1]}` : fullName;

  // SIEMPRE desde la plaza (parejas 1–2, 3–4…)
  const numAtril = p.atril;
  const ladoTxt  = (Number(p.puesto) === 1 ? 'I' : 'II');

  nodos += `
    <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
      <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
      <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
      <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>

      <text y="4" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT}">
        ${numAtril}
      </text>
      <text y="22" text-anchor="middle" font-size="10" fill="#fff" fill-opacity="0.95" font-family="${FONT}">
        ${ladoTxt}
      </text>

      <text y="46" text-anchor="middle" font-size="9" fill="#333" font-family="${FONT}">
        ${esc(displayName)}
      </text>
    </g>`;
}


    const cxDir = W/2, cyDirBase = H - 50;
    const director = `
      <g aria-label="Director">
        ${directorPodiumSVG(W / 2, H - 50)}
        <circle cx="${cxDir}" cy="${cyDirBase}" r="20" fill="#000"></circle>
        <circle cx="${cxDir}" cy="${cyDirBase}" r="22" fill="none" stroke="#fff" stroke-width="2"></circle>
        <text x="${cxDir}" y="${cyDirBase + 34}" text-anchor="middle" font-size="12" fill="#000" font-family="${FONT}">Director</text>
      </g>`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#FAF8F5"></rect>
        ${stageBackdropSVG(W, H)}
        <text x="${W/2}" y="36" text-anchor="middle" font-size="24" font-weight="800" letter-spacing=".3px" font-family="${FONT}">
          Prueba de atril  ${esc(grupoNombre)}
        </text>
        ${buildLegendFromPositions({ posiciones, x: 16, y: 16, fontFamily: FONT })}
        ${nodos}
        ${director}
      </svg>`;

    if (ext === 'svg') return res.type('image/svg+xml; charset=utf-8').send(svg);
    if (ext === 'pdf') {
      try {
        const pdfBuf = await svgToPdfBuffer(svg, { W, H, title: `Prueba de atril ${grupoNombre}` });
        return res.type('application/pdf').send(pdfBuf);
      } catch (e) {
        const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
        return res.type('image/png').send(png);
      }
    }
    const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error(e);
    return res.status(500).send('Error generando el plano.');
  }
});

router.get('/:grupo/:trimestreFriendly.:ext', async (req, res) => {
  const { grupo, trimestreFriendly: tfParam } = req.params;
  const ext = String(req.params.ext || '').toLowerCase();
  if (!new Set(['svg','png','pdf']).has(ext)) return res.status(404).send('Extensión no soportada');

  noCache(res);

  // Resolver trimestreFinal
  let trimestreFinal = (tfParam || '').trim();
  try {
    if (/^T[1-4]$/i.test(trimestreFinal)) {
      const sufijo = trimestreFinal.toUpperCase(); // "T1"
      const { rows: candidatos } = await pool.query(
        `SELECT DISTINCT trimestre
         FROM pruebas_atril_norm
         WHERE grupo = $1 AND trimestre LIKE '%' || $2`,
        [grupo, sufijo]
      );
      if (candidatos.length) {
        candidatos.sort((a, b) => {
          const ya = parseInt((a.trimestre.match(/^\d{2}\/(\d{2})T/) || [])[1] || '0', 10);
          const yb = parseInt((b.trimestre.match(/^\d{2}\/(\d{2})T/) || [])[1] || '0', 10);
          return yb - ya; // más reciente primero
        });
        trimestreFinal = candidatos[0].trimestre;
      } else {
        const { type, buf } = await renderMsg(
          ext,
          `No hay informes para ${grupo} — ${sufijo}.`,
          `Crea un informe "Prueba de atril XX/XX${sufijo}" y completa Grupo e Instrumento en el formulario.`
        );
        return res.type(type).send(buf);
      }
    } else if (/^\d{2}-\d{2}T[1-4]$/i.test(trimestreFinal)) {
      trimestreFinal = trimestreFinal.replace('-', '/'); // "25-26T1" -> "25/26T1"
    }

    // Consulta principal con mapeo Violín → Violín I/II
    const { rows: ranking } = await pool.query(
      `SELECT
          CASE
            WHEN regexp_replace(p.instrumento, '\\s+I{1,2}$', '', 'i') ~* '^viol[ií]n$' THEN
              COALESCE(
                (
                  SELECT g.nombre
                  FROM alumno_grupo ag
                  JOIN grupos g ON g.id = ag.grupo_id
                  WHERE ag.alumno_id = a.id
                    AND (
                    g.nombre ~* '^viol[ií]n\\s*i$'
                    OR g.nombre ~* '^viol[ií]n\\s*ii$'
                  )
                  ORDER BY
                    CASE
                      WHEN g.nombre ~* '^viol[ií]n\\s*i$'  THEN 1
                      WHEN g.nombre ~* '^viol[ií]n\\s*ii$' THEN 2
                      ELSE 3
                    END
                  LIMIT 1
                ),
                'Violín II'
              )
            ELSE p.instrumento
          END AS instrumento,
          p.alumno_id::text AS alumno_id,
          p.puntuacion,
          trim(coalesce(a.nombre,'') || ' ' || coalesce(a.apellidos,'')) AS nombre
        FROM pruebas_atril_norm p
        LEFT JOIN alumnos a
          ON a.id::text = trim(p.alumno_id)
        WHERE p.grupo = $1
          AND p.trimestre = $2
          AND p.asistencia = TRUE
        ORDER BY instrumento, p.puntuacion DESC, p.alumno_id ASC`,
      [grupo, trimestreFinal]
    );

    if (!ranking.length) {
      const { type, buf } = await renderMsg(ext, `No hay datos para ${grupo} — ${trimestreFinal}.`,
        `Asegúrate de marcar asistencia y de que existan puntuaciones en ese trimestre.`);
      return res.type(type).send(buf);
    }

    // Layout
    const counts = {};
    for (const r of ranking) counts[r.instrumento] = (counts[r.instrumento] || 0) + 1;
    const posiciones = autoLayoutFromCounts(counts);

    // Agrupación / asignación
    const porInstrumento = new Map();
    for (const r of ranking) {
      const key = r.instrumento;
      if (!porInstrumento.has(key)) porInstrumento.set(key, []);
      porInstrumento.get(key).push(r);
    }
    const asignacion = new Map();
    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const lista = porInstrumento.get(inst) || [];
      const plazas = posiciones.filter(p => p.instrumento === inst)
        .sort((a, b) => a.atril - b.atril || a.puesto - b.puesto);
      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand = { ...lista[i], seat: i + 1 };
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    // Render
    // Render
const W = 1400, H = 900, FONT = FONT_STACK;

let nodos = '';
for (const p of posiciones) {
  const key  = `${p.instrumento}|${p.atril}|${p.puesto}`;
  const asig = asignacion.get(key);
  if (!asig) continue;

  const cx = p.x * W, cy = p.y * H;
  const color = colorPorInstrumento(p.instrumento);

  // Nombre corto
  const fullName = asig.nombre || asig.alumno_id || '';
  const parts = fullName.trim().split(/\s+/);
  const displayName = (parts.length >= 3) ? `${parts[0]} ${parts[1]}` : fullName;

  // SIEMPRE desde la plaza (parejas 1–2, 3–4…)
  const numAtril = p.atril;
  const ladoTxt  = (Number(p.puesto) === 1 ? 'I' : 'II');

  nodos += `
    <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
      <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
      <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
      <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>

      <text y="4" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT}">
        ${numAtril}
      </text>
      <text y="22" text-anchor="middle" font-size="10" fill="#fff" fill-opacity="0.95" font-family="${FONT}">
        ${ladoTxt}
      </text>

      <text y="46" text-anchor="middle" font-size="9" fill="#333" font-family="${FONT}">
        ${esc(displayName)}
      </text>
    </g>`;
} 
    const cxDir = W / 2, cyDir = H - 50;
    const director = `
      <g aria-label="Director">
        ${directorPodiumSVG(W / 2, H - 50)}
        <circle cx="${cxDir}" cy="${cyDir}" r="20" fill="#000"></circle>
        <circle cx="${cxDir}" cy="${cyDir}" r="22" fill="none" stroke="#fff" stroke-width="2"></circle>
        <text x="${cxDir}" y="${cyDir + 34}" text-anchor="middle" font-size="12" fill="#000" font-family="${FONT_STACK}">Director</text>
      </g>`;

    const leyendaSVG = buildLegendFromPositions({ posiciones, x: 16, y: 16, fontFamily: FONT_STACK });

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#FAF8F5"></rect>
        ${stageBackdropSVG(W, H)}
        <text x="${W / 2}" y="36" text-anchor="middle" font-size="24" font-weight="800" letter-spacing=".3px" font-family="${FONT_STACK}">
          Pruebas de atril  ${esc(grupo)}  ${esc(trimestreFinal)}
        </text>
        ${leyendaSVG}
        ${nodos}
        ${director}
      </svg>`;

    if (ext === 'svg') return res.type('image/svg+xml; charset=utf-8').send(svg);
    if (ext === 'pdf') {
      try {
        const pdfBuf = await svgToPdfBuffer(svg, { W, H, title: `Pruebas de atril ${grupo} ${trimestreFinal}` });
        return res.type('application/pdf').send(pdfBuf);
      } catch (err) {
        const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
        return res.type('image/png').send(png);
      }
    }
    const png = await sharp(Buffer.from(svg), { density: 220 }).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error(e);
    return res.status(500).send('Error generando el plano');
  }
});
router.get('/view', (req, res) => {
  const grupo = req.query.grupo || 'JOSG';
  const trimestreFriendly = (req.query.trimestre || '25-26T1');
  res.render('plano', { grupo, trimestre: trimestreFriendly });
});
// GET /plano/layout?scope=grupo&scope_id=123
router.get('/layout', async (req, res) => {
  const scope = (req.query.scope || 'grupo').toString();
  const scopeId = Number(req.query.scope_id);
  if (!['grupo','evento'].includes(scope) || !Number.isInteger(scopeId)) {
    return res.status(400).json({ error:'scope (grupo|evento) y scope_id válidos' });
  }
  const { rows } = await pool.query(
    `SELECT key, x, y, angle FROM public.plano_layout WHERE scope=$1 AND scope_id=$2`,
    [scope, scopeId]
  );
  res.json({ items: rows });
});
// PUT /plano/layout  { scope, scope_id, updates:[{key,x,y,angle}...] }
router.put('/layout', express.json(), async (req, res) => {
  const { scope='grupo', scope_id, updates=[] } = req.body || {};
  const scopeId = Number(scope_id);
  if (!['grupo','evento'].includes(scope) || !Number.isInteger(scopeId) || !Array.isArray(updates)) {
    return res.status(400).json({ ok:false, error:'payload inválido' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(`
        INSERT INTO public.plano_layout (scope, scope_id, key, x, y, angle)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (scope, scope_id, key)
        DO UPDATE SET x=EXCLUDED.x, y=EXCLUDED.y, angle=EXCLUDED.angle, updated_at=now()
      `, [scope, scopeId, u.key, u.x, u.y, u.angle]);
    }
    await client.query('COMMIT');
    res.json({ ok:true, saved: updates.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[plano] PUT /plano/layout', e);
    res.status(500).json({ ok:false, error:'Error guardando layout' });
  } finally {
    client.release();
  }
});

router.get('/editor/latest', isAuthenticated, (req, res) => {
  res.render('plano_editor_latest', {
    title: 'Editor de plano',
    grupo_id: req.query.grupo_id || '',
    inst: req.query.inst || ''
  });
});

router.get('/editor/clasif', isAuthenticated, (req, res) => {
  res.render('plano_editor_latest', {
    title: 'Editor de plano',
    grupo_id: req.query.grupo_id || '',
    inst: req.query.inst || '',
    src: 'clasif'
  });
});

router.delete('/layout', async (req, res) => {
  try {
    const scope = (req.query.scope || 'grupo').toString();
    const scopeId = Number(req.query.scope_id);
    if (!['grupo','evento'].includes(scope) || !Number.isInteger(scopeId) || scopeId <= 0) {
      return res.status(400).json({ ok:false, error:'scope (grupo|evento) y scope_id válidos' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM public.plano_layout WHERE scope=$1 AND scope_id=$2`,
      [scope, scopeId]
    );
    return res.json({ ok:true, deleted: rowCount });
  } catch (e) {
    console.error('[plano] DELETE /plano/layout error:', e);
    return res.status(500).json({ ok:false, error:'Error borrando layout' });
  }
});
router.get('/editor/evento', isAuthenticated, async (req, res) => {
  const eventoId = Number(req.query.evento_id);
  if (!Number.isInteger(eventoId)) return res.status(400).send('Falta evento_id');
  res.render('plano_editor_latest', {
    title: 'Editor de plano (evento)',
    hero: false,
    grupo_id: String(eventoId), // el editor lo llama grupo_id
    src: 'evento',
    inst: req.query.inst || ''
  });
});
// GET card-data
router.get('/card-data', async (req, res) => {
  const { scope, scope_id } = req.query;
  if (!scope || !scope_id) return res.status(400).json({ error: 'faltan campos' });
  const rows = await db('plano_card_texts')
    .select('card_key as key', 'num', 'part')
    .where({ scope, scope_id });
  res.json({ items: rows });
});

// PUT card-data (upsert)
router.put('/card-data', async (req, res) => {
  const { scope, scope_id, key, num = null, part = null } = req.body || {};
  if (!scope || !scope_id || !key) return res.status(400).json({ error: 'faltan campos' });

  await db.raw(`
    INSERT INTO plano_card_texts (scope, scope_id, card_key, num, part)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scope, scope_id, card_key)
    DO UPDATE SET num = EXCLUDED.num, part = EXCLUDED.part, updated_at = now()
  `, [scope, scope_id, key, num, part]);

  res.json({ ok: true });
});

module.exports = router;


