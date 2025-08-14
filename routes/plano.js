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
  // Separación: cuerdas más juntas para liberar centro
  const dxStrings = 0.10; // antes ~0.12
  const dxWinds   = 0.12; // vientos con buen aire

  // Fila 1 (abajo/público): cuerdas
  const row1 = { yBottom: 0.88, yTop: 0.72 };
  // Capa intermedia para Vln II / Viola (un paso más atrás que su par de abajo)
  const row1mid = { yBottom: 0.68, yTop: 0.56 };

  // Fila 2 (antepenúltima): Flauta / Oboe
  const row2 = { yBottom: 0.50, yTop: 0.40, dx: dxWinds };

  // Fila 3 (penúltima): Clarinete / Fagot / Trompa / Trompeta
  const row3 = { yBottom: 0.38, yTop: 0.30, dx: dxWinds };

  // Fila 4 (última): Trombón / Tuba / Percusión (fila simple)
  const row4y = 0.24;

  // ===== CUERDAS (más juntas y algo más centradas) =====
  const specStrings = {
    // Izquierda, más cerca del centro
    'Violín I': {
      xRight: 0.42, yBottom: row1.yBottom, yTop: row1.yTop, dx: dxStrings, dir: 'R2L'
    },
    // Encima de Vln I, muy cerquita
    'Violín II': {
      xRight: 0.41, yBottom: row1mid.yBottom, yTop: row1mid.yTop, dx: dxStrings, dir: 'R2L'
    },

    // Derecha, también más cerca del centro
    'Violonchelo': {
      xLeft: 0.56, yBottom: row1.yBottom, yTop: row1.yTop, dx: dxStrings, dir: 'L2R'
    },
    // Encima de chelos, cerquita
    'Viola': {
      xLeft: 0.58, yBottom: row1mid.yBottom, yTop: row1mid.yTop, dx: dxStrings, dir: 'L2R'
    },
  };

  // ===== MADERA (fila 2: flauta/oboe) =====
  const specRow2 = {
    // Centradas dejando hueco a izquierda/derecha
    'Flauta':   { xLeft: 0.34, yBottom: row2.yBottom, yTop: row2.yTop, dx: row2.dx },
    'Oboe':     { xLeft: 0.48, yBottom: row2.yBottom, yTop: row2.yTop, dx: row2.dx },
  };

  // ===== MADERA GRAVE + METALES LIGEROS (fila 3) =====
  const specRow3 = {
    // Clarinetes bien en la zona alta del centro (¡ya no abajo!)
    'Clarinete': { xLeft: 0.40, yBottom: row3.yBottom, yTop: row3.yTop, dx: row3.dx },
    'Fagot':     { xLeft: 0.54, yBottom: row3.yBottom, yTop: row3.yTop, dx: row3.dx },
    'Trompa':    { xLeft: 0.68, yBottom: row3.yBottom, yTop: row3.yTop, dx: row3.dx },
    'Trompeta':  { xLeft: 0.82, yBottom: row3.yBottom, yTop: row3.yTop, dx: row3.dx },
  };

  // ===== ÚLTIMA FILA (simple) =====
  const specRow4 = {
    'Trombón':   { xLeft: 0.40, y: row4y, dx: dxWinds },
    'Tuba':      { xLeft: 0.60, y: row4y, dx: dxWinds },
    'Percusión': { xLeft: 0.80, y: row4y, dx: dxWinds },
  };

  // ===== Contrabajos: más ABAJO que antes (antes 0.20) =====
  const contrasRow = { y: 0.32, xRight: 0.92, dx: 0.12 }; // fila simple, derecha→izquierda

  const posiciones = [];

  for (const [inst, n] of Object.entries(counts)) {
    if (!n) continue;

    // CUERDAS
    if (specStrings[inst]) {
      const s = specStrings[inst];
      if (s.dir === 'R2L') {
        posiciones.push(...twoRowsRightToLeft(
          { xRight: s.xRight, yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst
        ));
      } else {
        posiciones.push(...twoRowsLeftToRight(
          { xLeft: s.xLeft, yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst
        ));
      }
      continue;
    }

    // FILA 2
    if (specRow2[inst]) {
      const s = specRow2[inst];
      posiciones.push(...twoRowsLeftToRight(
        { xLeft: s.xLeft, yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst
      ));
      continue;
    }

    // FILA 3
    if (specRow3[inst]) {
      const s = specRow3[inst];
      posiciones.push(...twoRowsLeftToRight(
        { xLeft: s.xLeft, yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst
      ));
      continue;
    }

    // FILA 4 (simple)
    if (specRow4[inst]) {
      const s = specRow4[inst];
      for (let i = 0; i < n; i++) {
        posiciones.push({ instrumento: inst, atril: i + 1, puesto: 1, x: s.xLeft + i * s.dx, y: s.y, angulo: 0 });
      }
      continue;
    }

    // CONTRABAJOS (fila simple, más abajo)
    if (inst === 'Contrabajo') {
      for (let i = 0; i < n; i++) {
        posiciones.push({ instrumento: inst, atril: i + 1, puesto: 1, x: contrasRow.xRight - i * contrasRow.dx, y: contrasRow.y, angulo: 0 });
      }
      continue;
    }

    // Fallback (por si llegara algo no contemplado): lo colocamos en fila 2
    const x0 = 0.18, yB = row2.yBottom, yT = row2.yTop, dx = dxWinds;
    const filas = Math.ceil(n / 2);
    for (let f = 0; f < filas; f++) {
      const atril = f + 1;
      const y = (f % 2 === 0) ? yB : yT;
      const rem = n - f * 2;
      const xf = x0 + f * dx;
      if (rem >= 2) {
        posiciones.push({ instrumento: inst, atril, puesto: 1, x: xf, y: yB, angulo: 0 });
        posiciones.push({ instrumento: inst, atril, puesto: 2, x: xf, y: yT, angulo: 0 });
      } else if (rem === 1) {
        posiciones.push({ instrumento: inst, atril, puesto: 1, x: xf, y: yB, angulo: 0 });
      }
    }
  }

  // Orden estable para numeración 1..N por instrumento
  posiciones.sort((a,b) =>
    a.instrumento.localeCompare(b.instrumento, 'es') ||
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

