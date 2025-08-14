// routes/plano.js
const express = require('express');
const router = express.Router();
const pool = require('../database/db'); // ajusta si tu db.js está en otro lugar
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

/* ===================== Utils ===================== */

// Colores por instrumento
function colorPorInstrumento(inst) {
  const colores = {
    // 🎻 Cuerdas (gama marrón)
    'Violín I':     '#8B4513', // SaddleBrown
    'Violín II':    '#A0522D', // Sienna
    'Viola':        '#CD853F', // Peru
    'Violonchelo':  '#D2691E', // Chocolate
    'Contrabajo':   '#DEB887', // BurlyWood

    // 🎼 Madera (gama gris-plateada)
    'Flauta':       '#C0C0C0', // Silver
    'Oboe':         '#A9A9A9', // DarkGray
    'Clarinete':    '#808080', // Gray
    'Fagot':        '#696969', // DimGray

    // 🎺 Metales (gama dorado-naranja)
    'Trompa':       '#FFD700', // Gold
    'Trompeta':     '#FFA500', // Orange
    'Trombón':      '#FF8C00', // DarkOrange
    'Tuba':         '#DAA520', // GoldenRod

    // 🥁 Percusión (rojo)
    'Percusión':    '#B22222', // FireBrick
  };
  return colores[inst] || '#999';
}


// (opcional) normalizador si algún informe viejo trae texto libre
function normalizaInstrumento(s) {
  if (!s) return s;
  const t = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g,'').trim();
  if (/^(violin|vln|violines)/.test(t)) {
    if (/(ii|2|segundos)/.test(t)) return 'Violín II';
    return 'Violín I';
  }
  if (/^viola$/.test(t)) return 'Viola';
  if (/^(violonchelo|cello)$/.test(t)) return 'Violonchelo';
  if (/^contrabajo$/.test(t)) return 'Contrabajo';
  if (/^violin/.test(t)) return 'Violín I';
  return s;
}

// === helpers de filas dobles ===

// violines: derecha → izquierda (1 abajo dcha, 2 arriba dcha, 3 abajo siguiente a la izq, ...)
function twoRowsRightToLeft({ xRight, yBottom, yTop, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / 2);          // 0,0,1,1,2,2...
    const isBottom = (i % 2) === 0;         // 0→abajo, 1→arriba
    const x = xRight - col * dx;
    const y = isBottom ? yBottom : yTop;
    const atril = col + 1;
    const puesto = isBottom ? 1 : 2;        // 1=Abajo, 2=Arriba
    posiciones.push({ instrumento, atril, puesto, x, y, angulo: 0 });
  }
  return posiciones;
}

// chelos/violas: izquierda → derecha (1 abajo izq, 2 arriba izq, 3 abajo sig. a la dcha, ...)
function twoRowsLeftToRight({ xLeft, yBottom, yTop, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / 2);
    const isBottom = (i % 2) === 0;
    const x = xLeft + col * dx;
    const y = isBottom ? yBottom : yTop;
    const atril = col + 1;
    const puesto = isBottom ? 1 : 2;        // 1=Abajo, 2=Arriba
    posiciones.push({ instrumento, atril, puesto, x, y, angulo: 0 });
  }
  return posiciones;
}

// === layout automático con reglas para Vln I/II, Viola, Violonchelo y Contrabajo ===
function autoLayoutFromCounts(counts) {
  // violines (izquierda), dx ancho
  const specVln = {
    'Violín I':  { xRight: 0.46, yBottom: 0.86, yTop: 0.74, dx: 0.08 },
    'Violín II': { xRight: 0.44, yBottom: 0.52, yTop: 0.40, dx: 0.08 }, // más arriba
  };

  // derecha (chelos abajo, violas arriba)
  const specRight = {
    'Violonchelo': { xLeft: 0.60, yBottom: 0.86, yTop: 0.74, dx: 0.08 },
    'Viola':       { xLeft: 0.62, yBottom: 0.52, yTop: 0.40, dx: 0.08 }, // más arriba
  };

  const posiciones = [];

  for (const [inst, n] of Object.entries(counts)) {
    if (n <= 0) continue;

    if (specVln[inst]) {
      posiciones.push(...twoRowsRightToLeft(specVln[inst], n, inst));
      continue;
    }
    if (specRight[inst]) {
      posiciones.push(...twoRowsLeftToRight(specRight[inst], n, inst));
      continue;
    }

    if (inst === 'Contrabajo') {
      // fila única atrás, más alta; de derecha → izquierda
      const y = 0.20;
      const xRight = 0.92, dx = 0.09;
      for (let i = 0; i < n; i++) {
        const x = xRight - i * dx;
        posiciones.push({ instrumento: inst, atril: i + 1, puesto: 1, x, y, angulo: 0 });
      }
      continue;
    }

    // fallback si aparecen otros instrumentos
    const x0 = 0.52, y0 = 0.66, dx = 0.10, dy = 0.10;
    const filas = Math.ceil(n / 2);
    for (let f = 0; f < filas; f++) {
      const atril = f + 1;
      const y = y0 + f * dy;
      const rem = n - f * 2;
      if (rem >= 2) {
        posiciones.push({ instrumento: inst, atril, puesto: 1, x: x0 - dx/2, y, angulo: 0 });
        posiciones.push({ instrumento: inst, atril, puesto: 2, x: x0 + dx/2, y, angulo: 0 });
      } else if (rem === 1) {
        posiciones.push({ instrumento: inst, atril, puesto: 1, x: x0, y, angulo: 0 });
      }
    }
  }

  posiciones.sort((a,b)=>
    a.instrumento.localeCompare(b.instrumento,'es') ||
    a.atril - b.atril || a.puesto - b.puesto
  );
  return posiciones;
}

/* ===================== Ruta principal ===================== */

// GET /plano/:grupo/:trimestreFriendly.:ext
router.get('/:grupo/:trimestreFriendly.:ext', async (req, res) => {
  const { grupo, trimestreFriendly, ext } = req.params;

  // Validar extensión
  const okExt = new Set(['svg', 'png', 'pdf']);
  if (!okExt.has(String(ext).toLowerCase())) {
    return res.status(404).send('Extensión no soportada');
  }

  // Resolver trimestreFinal
  let trimestreFinal = (trimestreFriendly || '').trim();
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
          return yb - ya;
        });
        trimestreFinal = candidatos[0].trimestre;
      } else {
        const msg = `
          <svg xmlns="http://www.w3.org/2000/svg" width="920" height="180">
            <rect width="100%" height="100%" fill="#fffbe6"/>
            <text x="20" y="60" font-size="22" font-family="system-ui,Segoe UI,Roboto,Arial" fill="#333">
              No hay informes para ${grupo} — ${sufijo}.
            </text>
            <text x="20" y="100" font-size="16" font-family="system-ui,Segoe UI,Roboto,Arial" fill="#555">
              Crea un informe "Prueba de atril 25/26${sufijo}" y completa Grupo e Instrumento en el formulario.
            </text>
          </svg>`;
        return res.type('image/svg+xml; charset=utf-8').send(msg);
      }
    } else if (/^\d{2}-\d{2}T[1-4]$/i.test(trimestreFinal)) {
      trimestreFinal = trimestreFinal.replace('-', '/'); // "25-26T1" -> "25/26T1"
    }

    // 1) Ranking (grupo + trimestreFinal + asistencia)
    const { rows: ranking } = await pool.query(
      `SELECT instrumento, alumno_id, puntuacion
       FROM pruebas_atril_norm
       WHERE grupo = $1 AND trimestre = $2 AND asistencia = TRUE
       ORDER BY instrumento, puntuacion DESC, alumno_id ASC`,
      [grupo, trimestreFinal]
    );

    // 2) Nombres de alumnos
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

    // 3) Posiciones dinámicas por conteo
    const counts = {};
    for (const r of ranking) counts[r.instrumento] = (counts[r.instrumento] || 0) + 1;
    const posiciones = autoLayoutFromCounts(counts);

    // === Leyenda dinámica (solo instrumentos presentes) ===
    const presentesSet = new Set(posiciones.map(p => p.instrumento));
    // Orden opcional para mostrar (solo los que estén presentes)
    const ordenLeyenda = [
  // Cuerdas
  'Violín I', 'Violín II', 'Viola', 'Violonchelo', 'Contrabajo',
  // Madera (antepenúltima y penúltima filas en tu plan)
  'Flauta', 'Oboe', 'Clarinete', 'Fagot',
  // Metal
  'Trompa', 'Trompeta', 'Trombón', 'Tuba',
  // Percusión
  'Percusión'
];
    const instrumentosPresentes = ordenLeyenda.filter(n => presentesSet.has(n));

    // Config panel compacto arriba-izquierda
    const legendCfg = { x: 16, y: 16, pad: 8, rowH: 20, boxW: 150 };
    const boxH = legendCfg.pad * 2 + instrumentosPresentes.length * legendCfg.rowH;

    let leyendaItems = '';
    let y = legendCfg.pad + 3;
    for (const inst of instrumentosPresentes) {
      const color = colorPorInstrumento(inst);
      leyendaItems += `
        <g transform="translate(${legendCfg.pad},${y - 12})">
          <rect width="14" height="14" rx="3" fill="${color}" stroke="#333" stroke-opacity="0.18"></rect>
          <text x="20" y="12" font-size="11" fill="#333"
                font-family="system-ui,Segoe UI,Roboto,Arial">${inst}</text>
        </g>`;
      y += legendCfg.rowH;
    }

    const leyendaSVG = instrumentosPresentes.length
      ? `<g transform="translate(${legendCfg.x},${legendCfg.y})">
           <rect x="0" y="0" width="${legendCfg.boxW}" height="${boxH}" rx="8" fill="white" stroke="#ccc"/>
           ${leyendaItems}
         </g>`
      : '';

    // 4) Agrupar por instrumento
    const porInstrumento = new Map();
    for (const r of ranking) {
      if (!porInstrumento.has(r.instrumento)) porInstrumento.set(r.instrumento, []);
      porInstrumento.get(r.instrumento).push(r);
    }

    // 5) Asignación sin vacantes (numeración 1..N por instrumento)
    const asignacion = new Map();
    for (const inst of new Set(posiciones.map(p => p.instrumento))) {
      const lista = porInstrumento.get(inst) || [];
      const plazas = posiciones
        .filter(p => p.instrumento === inst)
        .sort((a, b) => a.atril - b.atril || a.puesto - b.puesto);

      const n = Math.min(plazas.length, lista.length);
      for (let i = 0; i < n; i++) {
        const plaza = plazas[i];
        const cand = { ...lista[i], seat: i + 1 };
        asignacion.set(`${plaza.instrumento}|${plaza.atril}|${plaza.puesto}`, cand);
      }
    }

    // 6) Render
    const W = 1400, H = 900;
    let nodos = '';
    for (const p of posiciones) {
      const key = `${p.instrumento}|${p.atril}|${p.puesto}`;
      const asig = asignacion.get(key);
      if (!asig) continue;

      const cx = p.x * W, cy = p.y * H;
      const color = colorPorInstrumento(p.instrumento);
      const nombreAlumno = (nombrePorAlumno.get?.(asig.alumno_id)) || asig.alumno_id || '';

      nodos += `
        <g transform="translate(${cx},${cy}) rotate(${p.angulo})">
          <circle r="36" fill="${color}" fill-opacity="0.9"></circle>
          <circle r="38" fill="none" stroke="white" stroke-width="2"></circle>

          <!-- número dentro del círculo -->
          <text y="8" text-anchor="middle" font-weight="800" font-size="20" fill="#fff"
                font-family="system-ui,Segoe UI,Roboto,Arial">${asig.seat}</text>

          <!-- nombre debajo del círculo (más pequeño) -->
          <text y="54" text-anchor="middle" font-size="9" fill="#333"
                font-family="system-ui,Segoe UI,Roboto,Arial">${String(nombreAlumno).replace(/&/g,'&amp;')}</text>
        </g>`;
    }
    // 6.5) Marca del Director (centro inferior)
    const cxDir = W / 2;
    const cyDir = H - 50; // un poco por encima del borde inferior

    const director = `
      <g aria-label="Director">
        <!-- punto del director -->
        <circle cx="${cxDir}" cy="${cyDir}" r="20" fill="#000"></circle>
        <!-- fino anillo blanco para resaltar sobre fondos oscuros -->
        <circle cx="${cxDir}" cy="${cyDir}" r="22" fill="none" stroke="#fff" stroke-width="2"></circle>
        <!-- etiqueta -->
        <text x="${cxDir}" y="${cyDir + 34}" text-anchor="middle" font-size="12" fill="#000"
              font-family="system-ui,Segoe UI,Roboto,Arial">Director</text>
      </g>`;

        const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" rx="36" fill="#faf7f2"></rect>
        <text x="${W / 2}" y="48" text-anchor="middle" font-size="24" font-weight="700"
              font-family="system-ui,Segoe UI,Roboto,Arial">
          Pruebas de atril  ${grupo}  ${trimestreFinal}
        </text>
        ${leyendaSVG || ''}  <!-- si usas leyenda dinámica -->
        ${nodos}
        ${director}
      </svg>`;

    // 7) Salida
    if (ext === 'svg') return res.type('image/svg+xml; charset=utf-8').send(svg);

    if (ext === 'pdf') {
      try {
        const doc = new PDFDocument({
          size: [W, H],
          margin: 0,
          info: { Title: `Pruebas de atril  ${grupo}  ${trimestreFinal}`, Author: 'JOSG' }
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

    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    return res.type('image/png').send(png);

  } catch (e) {
    console.error(e);
    return res.status(500).send('Error generando el plano');
  }
});

// (Opcional) Vista simple para probar en navegador /plano/view?grupo=JOSG&trimestre=25-26T1
router.get('/view', (req, res) => {
  const grupo = req.query.grupo || 'JOSG';
  const trimestreFriendly = (req.query.trimestre || '25-26T1');
  res.render('plano', { grupo, trimestre: trimestreFriendly });
});

module.exports = router;

