// routes/plano.js
const express = require('express');
const router = express.Router();
const pool = require('../database/db');
const sharp = require('sharp'); // fallback PNG

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

/* ===================== /plano/latest/:grupo.:ext ===================== */
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

    // Query de “último por instrumento”
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
      SELECT p.instrumento,
             p.alumno_id::text AS alumno_id,
             p.puntuacion,
             l.trimestre AS trimestre,
             trim(coalesce(a.nombre,'') || ' ' || coalesce(a.apellidos,'')) AS nombre
      FROM parsed p
      JOIN latest l
        ON p.instrumento = l.instrumento AND p.trimestre = l.trimestre
      LEFT JOIN alumnos a
        ON a.id::text = trim(p.alumno_id)
      ORDER BY p.instrumento, p.puntuacion DESC, p.alumno_id ASC
    `, [grupoNombre]);

    if (!ranking.length) {
      const { type, buf } = await renderMsg(ext, `No hay datos recientes para ${grupoNombre}.`,
        `Asegúrate de que existan registros con asistencia en pruebas de atril.`);
      return res.type(type).send(buf);
    }

    // Conteos → layout
    const counts = {};
    for (const r of ranking) counts[r.instrumento] = (counts[r.instrumento] || 0) + 1;
    const posiciones = autoLayoutFromCounts(counts);

    // Agrupar por instrumento
    const porInstrumento = new Map();
    for (const r of ranking) {
      if (!porInstrumento.has(r.instrumento)) porInstrumento.set(r.instrumento, []);
      porInstrumento.get(r.instrumento).push(r);
    }

    // Asignación
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
    const W = 1400, H = 900, FONT = FONT_STACK;

    let nodos = '';
    for (const p of posiciones) {
      const key = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue;
      const cx = p.x * W, cy = p.y * H;
      const color = colorPorInstrumento(p.instrumento);
      nodos += `
        <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
          <!-- círculo base -->
          <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
          <!-- halo blanco interior -->
          <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
          <!-- aro exterior sutil -->
          <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>
          <!-- número -->
          <text y="6" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT}">${asig.seat}</text>
          <!-- nombre abreviado -->
          <text y="46" text-anchor="middle" font-size="9" fill="#333" font-family="${FONT}">
            ${esc(abbreviateName((asig.nombre && asig.nombre.trim().length ? asig.nombre : asig.alumno_id) || '', { max: 16 }))}
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

/* ===================== /plano/:grupo/:trimestre.:ext ===================== */
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

    // Consulta principal (con nombres)
    const { rows: ranking } = await pool.query(
      `SELECT p.instrumento,
              p.alumno_id::text AS alumno_id,
              p.puntuacion,
              trim(coalesce(a.nombre,'') || ' ' || coalesce(a.apellidos,'')) AS nombre
       FROM pruebas_atril_norm p
       LEFT JOIN alumnos a
         ON a.id::text = trim(p.alumno_id)
       WHERE p.grupo = $1
         AND p.trimestre = $2
         AND p.asistencia = TRUE
       ORDER BY p.instrumento, p.puntuacion DESC, p.alumno_id ASC`,
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
    const W = 1400, H = 900;

    let nodos = '';
    for (const p of posiciones) {
      const key = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue;
      const cx = p.x * W, cy = p.y * H;
      const color = colorPorInstrumento(p.instrumento);
      nodos += `
        <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
          <!-- círculo base -->
          <circle r="30" fill="${color}" fill-opacity="0.9"></circle>
          <!-- halo blanco interior -->
          <circle r="31.5" fill="none" stroke="#fff" stroke-width="2"></circle>
          <!-- aro exterior sutil -->
          <circle r="33" fill="none" stroke="#222" stroke-opacity="0.15" stroke-width="1.2"></circle>
          <!-- número -->
          <text y="6" text-anchor="middle" font-weight="800" font-size="18" fill="#fff" font-family="${FONT_STACK}">${asig.seat}</text>
          <!-- nombre abreviado -->
          <text y="46" text-anchor="middle" font-size="8" fill="#333" font-family="${FONT_STACK}">
            ${esc(abbreviateName((asig.nombre && asig.nombre.trim().length ? asig.nombre : asig.alumno_id) || '', { max: 16 }))}
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
        console.error('PDF vectorial falló, envío PNG:', err);
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

/* ===================== Vista simple ===================== */
router.get('/view', (req, res) => {
  const grupo = req.query.grupo || 'JOSG';
  const trimestreFriendly = (req.query.trimestre || '25-26T1');
  res.render('plano', { grupo, trimestre: trimestreFriendly });
});

module.exports = router;

