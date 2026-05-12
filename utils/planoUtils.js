// utils/planoUtils.js
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

/* ===================== Constantes ===================== */
const FONT_STACK =
  "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Liberation Sans', Ubuntu, Cantarell, 'DejaVu Sans', sans-serif";

/* ===================== Colores / instrumentos ===================== */

const COLORES = {
  // 🎻 Cuerdas (gama de marrones)
  'Violín I':    '#4F372F',
  'Violín II':   '#A1887F',
  'Viola':       '#B5651D',
  'Violonchelo': '#D2691E',
  'Contrabajo':  '#F5DEB3',

  // 🎼 Madera (gris-plateada)
  'Flauta':    '#C0C0C0',
  'Oboe':      '#000000',
  'Clarinete': '#909090',
  'Fagot':     '#616161',

  // 🎺 Metales (dorados/naranjas)
  'Trompa':   '#FFD700',
  'Trompeta': '#FFC400',
  'Trombón':  '#FFAA00',
  'Tuba':     '#E65100',

  // 🥁 Percusión (rojo)
  'Percusión': '#B22222',
  'Batería':   '#6A1B9A',
};


function colorPorInstrumento(inst) {
  return COLORES[inst] || '#999';
}

/* ===================== SVG / PDF helpers ===================== */
function esc(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function svgToPdfBuffer(svg, { W, H, title }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: title } });
      try {
        const interPath = path.join(__dirname, '../assets/fonts/Inter/Inter-Variable.ttf');
        if (fs.existsSync(interPath)) doc.registerFont('Inter', interPath);
      } catch {}
      const stream = new PassThrough();
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      doc.pipe(stream);
      SVGtoPDF(doc, svg, 0, 0, { width: W, height: H, preserveAspectRatio: 'xMinYMin meet', assumePt: true });
      doc.end();
    } catch (e) { reject(e); }
  });
}

function svgMensaje(msg1, msg2='') {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="920" height="180">
    <rect width="100%" height="100%" fill="#fffbe6"/>
    <text x="20" y="60" font-size="22" font-family="${FONT_STACK}" fill="#333">${esc(msg1)}</text>
    <text x="20" y="100" font-size="16" font-family="${FONT_STACK}" fill="#555">${esc(msg2)}</text>
  </svg>`;
}

async function renderMsg(ext, m1, m2) {
  const msvg = svgMensaje(m1, m2);
  if (ext === 'svg') return { type: 'image/svg+xml; charset=utf-8', buf: Buffer.from(msvg) };
  if (ext === 'pdf') {
    const pdf = await svgToPdfBuffer(msvg, { W: 920, H: 180, title: m1 });
    return { type: 'application/pdf', buf: pdf };
  }
  const png = await sharp(Buffer.from(msvg), { density: 220 }).png().toBuffer();
  return { type: 'image/png', buf: png };
}

/* ===================== Helpers de colocación ===================== */
function twoRowsRightToLeft({ xRight, yBottom, yTop, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / 2);
    const isBottom = (i % 2) === 0;
    posiciones.push({
      instrumento, atril: col + 1, puesto: isBottom ? 1 : 2,
      x: xRight - col * dx, y: isBottom ? yBottom : yTop, angulo: 0
    });
  }
  return posiciones;
}

function twoRowsLeftToRight({ xLeft, yBottom, yTop, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / 2);
    const isBottom = (i % 2) === 0;
    posiciones.push({
      instrumento, atril: col + 1, puesto: isBottom ? 1 : 2,
      x: xLeft + col * dx, y: isBottom ? yBottom : yTop, angulo: 0
    });
  }
  return posiciones;
}

function oneRowLeftToRight({ xLeft, y, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) posiciones.push({ instrumento, atril: i + 1, puesto: 1, x: xLeft + i * dx, y, angulo: 0 });
  return posiciones;
}

function oneRowRightToLeft({ xRight, y, dx }, n, instrumento) {
  const posiciones = [];
  for (let i = 0; i < n; i++) posiciones.push({ instrumento, atril: i + 1, puesto: 1, x: xRight - i * dx, y, angulo: 0 });
  return posiciones;
}

function packHalf(blockSeeds, counts, { xMin, xMax, dxBase, minGap = 0.014, minDx = 0.052 }) {
  const items = blockSeeds.map(b => ({ ...b, n: counts[b.name] || 0 })).filter(b => b.n > 0);
  if (!items.length) return [];
  const totalWidthBase = items.reduce((acc, b, i) => acc + ((b.n - 1) * dxBase) + (i > 0 ? minGap : 0), 0);
  const avail = Math.max(0, xMax - xMin);
  let dx = dxBase;
  if (totalWidthBase > avail) {
    const scale = avail / totalWidthBase;
    dx = Math.max(minDx, dxBase * scale);
  }
  const packed = [];
  let cursor = xMin;
  for (const b of items) {
    const width = (b.n - 1) * dx;
    let xLeft = Math.max(b.seedXLeft ?? xMin, cursor);
    xLeft = Math.min(xLeft, xMax - width);
    packed.push({ name: b.name, xLeft, y: b.y, dx, n: b.n });
    cursor = xLeft + width + minGap;
    if (cursor > xMax) cursor = xMax;
  }
  return packed;
}

function packHalfUniformConcat({ orderCenterOut, counts, y, xLeftBound, xRightBound, dxBase = 0.068 }) {
  const parts = orderCenterOut.map(name => ({ name, n: counts[name] || 0 })).filter(p => p.n > 0);
  if (!parts.length) return [];
  const totalSeats = parts.reduce((a,p)=>a+p.n,0);
  const avail = Math.max(0, xRightBound - xLeftBound);
  const steps = Math.max(1, totalSeats - 1);
  const dx = Math.min(dxBase, avail / steps);
  const totalWidth = (totalSeats - 1) * dx;

  let cursor = xRightBound - totalWidth;
  const out = [];
  for (const p of parts) {
    const width = (p.n - 1) * dx;
    out.push({ name: p.name, xLeft: cursor, y, dx, n: p.n });
    cursor += width;
    if (p !== parts[parts.length - 1]) cursor += dx;
  }
  return out;
}
// Calcula un desplazamiento vertical para centrar los nodos en una banda visible
function calcShiftY(posiciones, H, {
  bandTop = 100,
  bandBottom = H - 80,
  rNode = 32,
  nameBelow = 62     // nombre + instrumento debajo
} = {}) {
  if (!posiciones || !posiciones.length) return 0;
  const ys = posiciones.map(p => p.y * H);
  const minPix = Math.min(...ys) - rNode;
  const maxPix = Math.max(...ys) + nameBelow;
  const nodesCenter = (minPix + maxPix) / 2;
  const bandCenter = (bandTop + bandBottom) / 2;
  // limita para que todo quepa dentro de la banda
  return Math.max(bandTop - minPix, Math.min(bandBottom - maxPix, bandCenter - nodesCenter));
}
// Abrevia nombres largos de forma elegante: "Nombre Apellido" → "N. Apellido" → "N. A."
function abbreviateName(full = '', { max = 16 } = {}) {
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
}

// Fondo de escenario: semiluna muy sutil detrás de las cuerdas
function stageBackdropSVG(W, H) {
  const x1 = W * 0.06, x2 = W * 0.94, y = H * 0.72;
  const rx = W * 0.52, ry = H * 0.86;
  return `
    <path d="M ${x1} ${y}
             A ${rx} ${ry} 0 0 1 ${x2} ${y}
             L ${x2} ${H} L ${x1} ${H} Z"
          fill="#EAE6DF" fill-opacity="0.35"></path>`;
}

// Podio minimal del director (debajo del círculo)
function directorPodiumSVG(cx, cy) {
  const w = 64, h = 8, r = 2;
  return `<rect x="${cx - w/2}" y="${cy + 22}" width="${w}" height="${h}" rx="${r}" ry="${r}"
                fill="#CFCFCF" fill-opacity="0.6"></rect>`;
}

/* ===================== Layout dinámico ===================== */
function autoLayoutFromCounts(counts) {
  const dxStrings = 0.08;
  const dxWinds   = 0.07;
  const minGap    = 0.014;

  const rowStringsBottom = 0.88;
  const rowStringsTop    = 0.77;
  const gapBase = rowStringsBottom - rowStringsTop;
  const gap     = gapBase + 0.003;

  const v2Bottom = rowStringsTop - gap;
  const v2Top    = v2Bottom - gap;
  const vaBottom = v2Bottom;
  const vaTop    = v2Top;

  const offsetLeftStrings  = -0.015;
  const offsetRightStrings =  0.015;

  const xRightVlnI = 0.43 + offsetLeftStrings;
  const xLeftCello = 0.55 + offsetRightStrings;

  const specStrings = {
    'Violín I':    { xRight: xRightVlnI, yBottom: rowStringsBottom, yTop: rowStringsTop, dx: dxStrings, dir: 'R2L' },
    'Violín II':   { xRight: xRightVlnI, yBottom: v2Bottom,         yTop: v2Top,        dx: dxStrings, dir: 'R2L' },
    'Violonchelo': { xLeft:  xLeftCello, yBottom: rowStringsBottom, yTop: rowStringsTop, dx: dxStrings, dir: 'L2R' },
    'Viola':       { xLeft:  xLeftCello, yBottom: vaBottom,         yTop: vaTop,        dx: dxStrings, dir: 'L2R' },
  };

  const rowContrabajo = vaTop - gap;
  const specCB = { xRight: 0.96, y: rowContrabajo, dx: dxStrings };

  const PX = 1 / 900;
  const baseSep = 0.10;
  const EXTRA7 = 7 * PX;
  const EXTRA5 = 5 * PX;

  const sepCB_to_R1 = baseSep + EXTRA7 + EXTRA5;
  const sepR1_to_R2 = baseSep + EXTRA7 + EXTRA5;
  const sepR2_to_R3 = baseSep + EXTRA7 + EXTRA5;

  const rowR1 = Math.max(0, rowContrabajo - sepCB_to_R1);
  const rowR2 = Math.max(0, rowR1         - sepR1_to_R2);
  const rowR3 = Math.max(0, rowR2         - sepR2_to_R3);

  const centerX = 0.5;
  const centerMargin = 0.04;
  const xMin = 0.04, xMax = 0.96;
  const leftMax  = centerX - centerMargin;
  const rightMin = centerX + centerMargin;

  let packedR1L = packHalf([{ name: 'Flauta',    seedXLeft: 0.18,     y: rowR1, dx: dxWinds }], counts,
                           { xMin, xMax: leftMax, dxBase: dxWinds, minGap, minDx: 0.052 });
  let packedR1R = packHalf([{ name: 'Clarinete', seedXLeft: rightMin, y: rowR1, dx: dxWinds }], counts,
                           { xMin: rightMin, xMax, dxBase: dxWinds, minGap, minDx: 0.052 });

  // flautas pegadas al centro
  {
    const idxF = packedR1L.findIndex(b => b.name === 'Flauta');
    if (idxF !== -1) {
      const b = packedR1L[idxF];
      const width = (b.n - 1) * b.dx;
      packedR1L[idxF] = { ...b, xLeft: Math.max(xMin, leftMax - width) };
    }
  }

  const packedR2L = packHalfUniformConcat({
    orderCenterOut: ['Trompa','Oboe'], counts, y: rowR2,
    xLeftBound: xMin, xRightBound: leftMax, dxBase: dxWinds
  });
  const packedR2R = packHalfUniformConcat({
    orderCenterOut: ['Fagot','Trompeta'], counts, y: rowR2,
    xLeftBound: rightMin, xRightBound: xMax, dxBase: dxWinds
  });

  const packedR3L = packHalfUniformConcat({
    orderCenterOut: ['Percusión','Batería'], counts, y: rowR3,
    xLeftBound: xMin, xRightBound: leftMax, dxBase: dxWinds
  });
  const packedR3R = packHalfUniformConcat({
    orderCenterOut: ['Trombón','Tuba'], counts, y: rowR3,
    xLeftBound: rightMin, xRightBound: xMax, dxBase: dxWinds
  });

  const posiciones = [];

  for (const inst of ['Violín I','Violín II','Violonchelo','Viola']) {
    const n = counts[inst] || 0;
    if (!n) continue;
    const s = specStrings[inst];
    const arr = (s.dir === 'R2L')
      ? twoRowsRightToLeft({ xRight: s.xRight, yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst)
      : twoRowsLeftToRight ({ xLeft:  s.xLeft,  yBottom: s.yBottom, yTop: s.yTop, dx: s.dx }, n, inst);
    posiciones.push(...arr);
  }

  const nCB = counts['Contrabajo'] || 0;
  if (nCB > 0) posiciones.push(...oneRowRightToLeft({ xRight: specCB.xRight, y: specCB.y, dx: specCB.dx }, nCB, 'Contrabajo'));

  for (const b of [...packedR1L, ...packedR1R]) posiciones.push(...oneRowLeftToRight({ xLeft: b.xLeft, y: b.y, dx: b.dx }, b.n, b.name));
  for (const b of [...packedR2L, ...packedR2R]) posiciones.push(...oneRowLeftToRight({ xLeft: b.xLeft, y: b.y, dx: b.dx }, b.n, b.name));
  for (const b of [...packedR3L, ...packedR3R]) posiciones.push(...oneRowLeftToRight({ xLeft: b.xLeft, y: b.y, dx: b.dx }, b.n, b.name));

  // Numeraciones especiales
  {
    const fl = posiciones.filter(p => p.instrumento === 'Flauta').sort((a,b) => a.x - b.x);
    const n = fl.length; for (let i = 0; i < n; i++) fl[i].atril = n - i;
  }
  const renumRightToLeft = (inst) => {
    const arr = posiciones.filter(p => p.instrumento === inst).sort((a,b)=>a.x - b.x);
    const n = arr.length; for (let i = 0; i < n; i++) arr[i].atril = n - i;
  };
  ['Trompa','Oboe','Batería','Percusión'].forEach(renumRightToLeft);

  posiciones.sort((a,b) =>
    a.instrumento.localeCompare(b.instrumento, 'es') ||
    a.atril - b.atril || a.puesto - b.puesto
  );

  // ── Centrado adaptativo: simétrico respecto al director (X=0.5) y vertical ──
  if (posiciones.length > 0) {
    const totalMusicos = posiciones.length;

    // ¿Hay instrumentos en ambos lados o solo en uno?
    const xMedio = posiciones.reduce((s,p) => s + p.x, 0) / posiciones.length;
    const todosUnLado = posiciones.every(p => p.x > 0.55) || posiciones.every(p => p.x < 0.45);

    if (todosUnLado || totalMusicos <= 16) {
      // Redistribuir en arco simétrico centrado en X=0.5
      // Ordenar por instrumento para mantener grupos juntos, luego por X original
      const grupos = new Map();
      for (const p of posiciones) {
        if (!grupos.has(p.instrumento)) grupos.set(p.instrumento, []);
        grupos.get(p.instrumento).push(p);
      }

      // Calcular ancho total necesario
      const dx = Math.min(0.08, 0.85 / Math.max(1, totalMusicos - 1));
      const totalAncho = (totalMusicos - 1) * dx;
      const xStart = 0.5 - totalAncho / 2;

      // Redistribuir manteniendo grupos juntos
      let idx = 0;
      for (const [inst, grupo] of grupos) {
        // Ordenar cada grupo por atril
        grupo.sort((a,b) => a.atril - b.atril || a.puesto - b.puesto);
        for (const p of grupo) {
          p.x = xStart + idx * dx;
          idx++;
        }
      }

      // Centrar verticalmente: bajar hacia el director (Y objetivo ~0.55-0.65)
      const ys = posiciones.map(p => p.y);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      const yRange = yMax - yMin;
      const targetYCenter = 0.42; // más cerca del director
      const targetYRange  = Math.min(yRange, 0.22); // comprimir si hay mucho espacio
      const yCenter = (yMin + yMax) / 2;
      const scale = yRange > 0.01 ? targetYRange / yRange : 1;

      for (const p of posiciones) {
        p.y = targetYCenter + (p.y - yCenter) * scale;
      }

    } else {
      // Orquesta más completa: solo ajustar si está muy descentrada
      const xs = posiciones.map(p => p.x);
      const xCenter = (Math.min(...xs) + Math.max(...xs)) / 2;
      const xShift = 0.5 - xCenter;
      if (Math.abs(xShift) > 0.03) {
        for (const p of posiciones) p.x += xShift;
      }

      const ys = posiciones.map(p => p.y);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      const yCenter = (yMin + yMax) / 2;
      const targetYCenter = 0.48;
      const shift = targetYCenter - yCenter;
      const shiftClamped = Math.max(-0.12, Math.min(0.12, shift));
      if (Math.abs(shiftClamped) > 0.02) {
        for (const p of posiciones) p.y += shiftClamped;
      }
    }
  }

  return posiciones;
}

/* ===================== Leyenda dinámica ===================== */
const ORDEN_LEYENDA = [
  'Violín I','Violín II','Viola','Violonchelo','Contrabajo',
  'Flauta','Oboe','Clarinete','Fagot',
  'Trompa','Trompeta','Trombón','Tuba',
  'Percusión','Batería'
];

function buildLegendFromPositions({
  posiciones,
  fontFamily,
  x = 16, y = 16,
  pad = 12, rowH = 20, boxW = 140,
  showCounts = false,
  W = 1400, H = 900,   // dimensiones del SVG para calcular posición
}) {
  const presentes = new Set(posiciones.map(p => p.instrumento));
  const presentesOrdenados = ORDEN_LEYENDA.filter(n => presentes.has(n));
  if (!presentesOrdenados.length) return '';

  const counts = posiciones.reduce((acc, p) => {
    acc[p.instrumento] = (acc[p.instrumento] || 0) + 1;
    return acc;
  }, {});

  const boxH = pad * 2 + presentesOrdenados.length * rowH;
  const margin = 16; // margen desde el borde
  const nodeR  = 50; // radio de influencia de cada ficha en píxeles

  // Las 4 esquinas candidatas (x, y en píxeles)
  const candidatas = [
    { cx: margin,         cy: margin },          // sup-izq
    { cx: W - boxW - margin, cy: margin },        // sup-der
    { cx: margin,         cy: H - boxH - margin },// inf-izq
    { cx: W - boxW - margin, cy: H - boxH - margin }, // inf-der
  ];

  // Para cada candidata calcular cuántas fichas se solapan
  function fichasEnCaja(cx, cy) {
    let count = 0;
    for (const p of posiciones) {
      const px = p.x * W;
      const py = p.y * H;
      // Comprobar si la ficha está dentro o cerca de la caja de la leyenda
      const overlapX = px + nodeR > cx && px - nodeR < cx + boxW;
      const overlapY = py + nodeR > cy && py - nodeR < cy + boxH;
      if (overlapX && overlapY) count++;
    }
    return count;
  }

  // Elegir la esquina con menos solapamiento
  let mejorX = candidatas[0].cx, mejorY = candidatas[0].cy;
  let mejorScore = Infinity;
  for (const c of candidatas) {
    const score = fichasEnCaja(c.cx, c.cy);
    if (score < mejorScore) {
      mejorScore = score;
      mejorX = c.cx;
      mejorY = c.cy;
    }
  }

  let items = '';
  let yLegend = pad + 10;
  for (const inst of presentesOrdenados) {
    const color = colorPorInstrumento(inst);
    const label = showCounts ? `${inst} (${counts[inst] || 0})` : inst;
    items += `
      <g transform="translate(${pad},${yLegend - 12})">
        <rect width="14" height="14" rx="3" fill="${color}" stroke="#333" stroke-opacity="0.18"></rect>
        <text x="20" y="12" font-size="11" fill="#333" font-family="${fontFamily}">${esc(label)}</text>
      </g>`;
    yLegend += rowH;
  }

  return `
    <g transform="translate(${mejorX},${mejorY})" aria-label="Leyenda">
      <rect x="0" y="0" width="${boxW}" height="${boxH}" rx="8" fill="white" fill-opacity="0.92" stroke="#ccc"></rect>
      ${items}
    </g>`;
}

/* ===================== Export público ===================== */
module.exports = {
  FONT_STACK,
  esc,
  svgToPdfBuffer,
  renderMsg,
  colorPorInstrumento,
  autoLayoutFromCounts,
  buildLegendFromPositions,
  // exporta COLORES si te interesa
  COLORES,
  calcShiftY,
  abbreviateName,
  stageBackdropSVG,
  directorPodiumSVG,
};
