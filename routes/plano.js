// routes/plano.js
const express = require('express');
const router = express.Router();

// 👇 Ajusta esta ruta si tu db.js no está en la raíz del proyecto
const pool = require('../database/db');

const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

// Colores por instrumento (ajústalos a tu gusto)
function colorPorInstrumento(inst) {
  const colores = {
    'Violín I': '#4e79a7',
    'Violín II': '#59a14f',
    'Viola': '#f28e2b',
    'Violonchelo': '#e15759',
    'Contrabajo': '#b07aa1',
  };
  return colores[inst] || '#999';
}

// GET /plano/:grupo/:trimestreFriendly.:ext   (p.ej. /plano/OEG/25-26T1.svg)
router.get('/:grupo/:trimestreFriendly.:ext', async (req, res) => {
  const { grupo, trimestreFriendly, ext } = req.params;
  const trimestre = (trimestreFriendly || '').replace('-', '/'); // "25-26T1" -> "25/26T1"

  // Validar extensión
  const okExt = new Set(['svg', 'png', 'pdf']);
  if (!okExt.has(String(ext).toLowerCase())) {
    return res.status(404).send('Extensión no soportada');
  }

  try {
    // 1) Posiciones del layout
    const { rows: posiciones } = await pool.query(`
      SELECT layout_id, instrumento, atril, puesto, x, y, COALESCE(angulo,0) AS angulo
      FROM layout_posiciones
      WHERE layout_id = 'escenario_cuerdas_v1'
      ORDER BY instrumento, atril, puesto
    `);

    // 2) Ranking desde la vista (grupo + trimestre + asistencia)
    const { rows: ranking } = await pool.query(
      `
      SELECT instrumento, alumno_id, puntuacion
      FROM pruebas_atril_norm
      WHERE grupo = $1 AND trimestre = $2 AND asistencia = TRUE
      ORDER BY instrumento, puntuacion DESC, alumno_id ASC
    `,
      [grupo, trimestre]
    );

    // Si no hay datos, devolvemos un SVG informativo
    if (ranking.length === 0) {
      const msg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="920" height="180">
          <rect width="100%" height="100%" fill="#fffbe6"/>
          <text x="20" y="60" font-size="22" font-family="system-ui,Segoe UI,Roboto,Arial" fill="#333">
            No hay registros para ${grupo} — ${trimestre}.
          </text>
          <text x="20" y="100" font-size="16" font-family="system-ui,Segoe UI,Roboto,Arial" fill="#555">
            Revisa el título del informe y los campos “Puntuación” y “Asistencia”.
          </text>
        </svg>`;
      return res.type('image/svg+xml; charset=utf-8').send(msg);
    }

    // 2.5) (Opcional) Cargar nombres de alumnos para rotular
    const ids = [...new Set(ranking.map(r => r.alumno_id).filter(Boolean))];
    let nombrePorAlumno = new Map();

    if (ids.length) {
      const intIds = ids.map(x => parseInt(x, 10)).filter(Number.isInteger);
      if (intIds.length) {
        const { rows: alumnos } = await pool.query(
          `SELECT id::text AS alumno_id,
                  trim(coalesce(nombre,'') || ' ' || coalesce(apellidos,'')) AS nombre
           FROM alumnos
           WHERE id = ANY($1::int[])`,
          [intIds]
        );
        nombrePorAlumno = new Map(alumnos.map(a => [a.alumno_id, a.nombre || a.alumno_id]));
      }
    }

    // 3) Agrupar candidatos por instrumento
    const porInstrumento = new Map();
    for (const r of ranking) {
      if (!porInstrumento.has(r.instrumento)) porInstrumento.set(r.instrumento, []);
      porInstrumento.get(r.instrumento).push(r);
    }

    // 4) Asignación SIN vacantes y numeración 1..N por instrumento
    const asignacion = new Map();
    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const lista = porInstrumento.get(inst) || []; // ordenada por puntuación DESC
      const plazas = posiciones
        .filter(p => p.instrumento === inst)
        .sort((a, b) => a.atril - b.atril || a.puesto - b.puesto);

      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand = { ...lista[i], seat: i + 1 }; // número correlativo 1..N
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    // 5) Render SVG (solo asientos asignados)
    const W = 1400, H = 900;
    let nodos = '';

    for (const p of posiciones) {
      const key = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue; // no dibujamos plazas sin asignar

      const cx = p.x * W, cy = p.y * H;
      const color = colorPorInstrumento(p.instrumento);
      const etiqueta = `${p.instrumento} • Atril ${p.atril} • ${p.puesto === 1 ? 'Izq' : 'Der'}`;
      const nombreAlumno = (nombrePorAlumno.get?.(asig.alumno_id)) || asig.alumno_id || '';

      nodos += `
        <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
          <circle r="36" fill="${color}" fill-opacity="0.9"></circle>
          <circle r="38" fill="none" stroke="white" stroke-width="2"></circle>

          <!-- etiqueta arriba -->
          <text y="-50" text-anchor="middle" font-size="16" fill="#333"
                font-family="system-ui,Segoe UI,Roboto,Arial">${etiqueta}</text>

          <!-- número grande dentro del círculo -->
          <text y="8" text-anchor="middle" font-weight="800" font-size="20" fill="#fff"
                font-family="system-ui,Segoe UI,Roboto,Arial">${asig.seat}</text>

          <!-- nombre debajo del círculo -->
          <text y="60" text-anchor="middle" font-size="14" fill="#333"
                font-family="system-ui,Segoe UI,Roboto,Arial">${String(nombreAlumno).replace(/&/g,'&amp;')}</text>
        </g>`;
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#faf7f2"></rect>
        <text x="${W / 2}" y="48" text-anchor="middle" font-size="24" font-weight="700">
          Plano de cuerdas — ${grupo} — ${trimestre}
        </text>
        ${nodos}
      </svg>`;

    // 6) Salida según extensión
    if (ext === 'svg') {
      return res.type('image/svg+xml; charset=utf-8').send(svg);
    }

    if (ext === 'pdf') {
      try {
        const doc = new PDFDocument({
          size: [W, H],
          margin: 0,
          info: { Title: `Plano cuerdas — ${grupo} — ${trimestre}`, Author: 'JOSG' }
        });
        res.type('application/pdf');
        doc.pipe(res);
        SVGtoPDF(doc, svg, 0, 0, { width: W, height: H, preserveAspectRatio: 'xMinYMin meet', assumePt: true });
        doc.end();
        return;
      } catch (err) {
        console.error('PDF vectorial falló, envío PNG:', err);
        const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
        return res.type('image/png').send(png);
      }
    }

    // PNG por defecto
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error(e);
    return res.status(500).send('Error generando el plano');
  }
});

router.get('/view', (req, res) => {
  const grupo = req.query.grupo || 'JOSG';
  const trimestreFriendly = (req.query.trimestre || '25-26T1'); // usar con guion
  res.render('plano', { grupo, trimestre: trimestreFriendly });
});

module.exports = router;
