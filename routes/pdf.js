// routes/pdf.js
const { Router } = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const pool = require('../database/db');

const router = Router();

/* ========================= Helpers ========================= */

// Nombres de alumnos (si existe la tabla). Si no, "Alumno <id>".
async function getAlumnosNombres(ids) {
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query(`
      SELECT id, COALESCE(TRIM(nombre || ' ' || apellidos), nombre::text, id::text) AS nombre
      FROM alumnos
      WHERE id = ANY($1::int[])
    `, [ids]);
    const m = new Map();
    rows.forEach(r => m.set(String(r.id), r.nombre || `Alumno ${r.id}`));
    return m;
  } catch {
    const m = new Map();
    ids.forEach(id => m.set(String(id), `Alumno ${id}`));
    return m;
  }
}

// Grupo(s) por alumno – intenta ambos nombres de tabla: alumno_grupo / alumnos_grupos
async function getGruposPorAlumno(ids) {
  const m = new Map();
  if (!ids.length) return m;
  try {
    const { rows } = await pool.query(`
      SELECT ag.alumno_id, STRING_AGG(g.nombre, ', ' ORDER BY g.nombre) AS grupos
      FROM alumno_grupo ag
      JOIN grupos g ON g.id = ag.grupo_id
      WHERE ag.alumno_id = ANY($1::int[])
      GROUP BY ag.alumno_id
    `, [ids]);
    rows.forEach(r => m.set(String(r.alumno_id), r.grupos || ''));
    return m;
  } catch {
    try {
      const { rows } = await pool.query(`
        SELECT ag.alumno_id, STRING_AGG(g.nombre, ', ' ORDER BY g.nombre) AS grupos
        FROM alumnos_grupos ag
        JOIN grupos g ON g.id = ag.grupo_id
        WHERE ag.alumno_id = ANY($1::int[])
        GROUP BY ag.alumno_id
      `, [ids]);
      rows.forEach(r => m.set(String(r.alumno_id), r.grupos || ''));
    } catch {}
    return m;
  }
}

// Instrumento(s) por alumno – intenta ambos nombres: alumno_instrumento / alumnos_instrumentos
async function getInstrumentosPorAlumno(ids) {
  const m = new Map();
  if (!ids.length) return m;
  try {
    const { rows } = await pool.query(`
      SELECT ai.alumno_id, STRING_AGG(i.nombre, ', ' ORDER BY i.nombre) AS instrumentos
      FROM alumno_instrumento ai
      JOIN instrumentos i ON i.id = ai.instrumento_id
      WHERE ai.alumno_id = ANY($1::int[])
      GROUP BY ai.alumno_id
    `, [ids]);
    rows.forEach(r => m.set(String(r.alumno_id), r.instrumentos || ''));
    return m;
  } catch {
    try {
      const { rows } = await pool.query(`
        SELECT ai.alumno_id, STRING_AGG(i.nombre, ', ' ORDER BY i.nombre) AS instrumentos
        FROM alumnos_instrumentos ai
        JOIN instrumentos i ON i.id = ai.instrumento_id
        WHERE ai.alumno_id = ANY($1::int[])
        GROUP BY ai.alumno_id
      `, [ids]);
      rows.forEach(r => m.set(String(r.alumno_id), r.instrumentos || ''));
    } catch {}
    return m;
  }
}

// Asegura columna public_slug (por si el entorno no la tiene aún)
let _slugChecked = false;
async function ensurePublicSlugColumn() {
  if (_slugChecked) return;
  try {
    await pool.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS public_slug TEXT UNIQUE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_informes_slug ON informes(public_slug);`);
  } finally {
    _slugChecked = true;
  }
}

// Parse boolean de querystring
const parseBoolQS = (v) => {
  if (v == null) return undefined;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 't' || s === 'sí' || s === 'si';
};

/* ==================== Generación de PDF ==================== */

async function streamInformePDF(res, informeId, opts = {}) {
  // --- Datos base ---
  const { rows: [inf] } = await pool.query(`
    SELECT i.id, i.informe, i.fecha, i.observaciones,
           i.grupo_id, g.nombre  AS grupo_nombre,
           i.instrumento_id, ins.nombre AS instrumento_nombre
    FROM informes i
    LEFT JOIN grupos g  ON g.id  = i.grupo_id
    LEFT JOIN instrumentos ins ON ins.id = i.instrumento_id
    WHERE i.id = $1
  `, [informeId]);
  if (!inf) { res.status(404).send('Informe no encontrado'); return; }

  const { rows: campos } = await pool.query(`
    SELECT id, nombre, tipo, obligatorio
    FROM informe_campos
    WHERE informe_id = $1
    ORDER BY id
  `, [informeId]);

  const { rows: resultados } = await pool.query(`
    SELECT alumno_id, campo_id, valor, fila
    FROM informe_resultados
    WHERE informe_id = $1
    ORDER BY COALESCE(fila, 2147483647), alumno_id, campo_id
  `, [informeId]);

  // --- Filtro especial para informes de "porcentaje de horas" ---
// --- Filtro especial para informes de "porcentaje de horas..." ---
// Quitamos cualquier columna de campos cuyo nombre haga referencia a "Alumno"
// (igual que en la vista, pero sin depender de la posición).
const norm = (s) =>
  (s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().trim();

const tituloNorm = norm(inf.informe);
const isHoras = tituloNorm.includes('porcentaje de horas');

function esColumnaAlumnoRedundante(campo) {
  const n = norm(campo.nombre);
  // Coincidencias amplias: "alumno", "alumnos", "id alumno", "alumno id", etc.
  if (!n) return false;
  if (n === 'alumno' || n === 'alumnos') return true;
  if (n.includes('alumno')) return true;
  if (/(^|[\s_\-])(id|dni)[\s_\-]*alumno($|[\s_\-])/.test(n)) return true;
  if (/(^|[\s_\-])alumno[\s_\-]*(id|dni)($|[\s_\-])/.test(n)) return true;
  return false;
}

// Por defecto, no tocamos campos. Si es informe de horas, filtramos.
let camposV = isHoras ? campos.filter(c => !esColumnaAlumnoRedundante(c)) : campos.slice();



  // --- Fechas seguras ---
  const fmtDate  = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' });
  const fmtMonth = new Intl.DateTimeFormat('es-ES', { month: 'long' });
  const toDateSafe = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const formatDateSafe = (v) => {
    const d = toDateSafe(v);
    return d ? fmtDate.format(d) : '-';
  };
  const isoDateSafe = (v) => {
    const d = toDateSafe(v);
    return d ? d.toISOString().slice(0,10) : null;
  };

  // --- Cache HTTP ---
  const etagBase = JSON.stringify({ f: isoDateSafe(inf.fecha), nC: campos.length, nR: resultados.length });
  const etag = crypto.createHash('sha1').update(etagBase).digest('hex');
  if (res.req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=86400');

  // --- Cabeceras HTTP ---
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="informe-${informeId}.pdf"`);

  // --- Pivot filas ---
  const alumnosIds = [...new Set(resultados.map(r => r.alumno_id).filter(v => v !== null))];
  const nombreAlumno = await getAlumnosNombres(alumnosIds);
  const gruposAlumno = await getGruposPorAlumno(alumnosIds);
  const instrAlumno  = await getInstrumentosPorAlumno(alumnosIds);

  const porFila = new Map(); // clave: "alumnoId|fila"
  for (const r of resultados) {
    const key = `${r.alumno_id ?? 'null'}|${r.fila ?? 999999}`;
    if (!porFila.has(key)) porFila.set(key, { alumnoId: r.alumno_id, fila: r.fila ?? 999999, c: new Map() });
    porFila.get(key).c.set(r.campo_id, r.valor);
  }
  const filas = [...porFila.values()].sort((a,b)=> a.fila - b.fila || (a.alumnoId ?? 0) - (b.alumnoId ?? 0));

  // --- Flags visibilidad (reflejan la vista) ---
  const showGroup      = (typeof opts.showGroup === 'boolean') ? opts.showGroup : false;
  const showInstrument = (typeof opts.showInstrument === 'boolean') ? opts.showInstrument : false;

  // --- Crear PDF ---
  const orientation = camposV.length > 6 ? 'landscape' : 'portrait';
  const pdf = new PDFDocument({ size: 'A4', layout: orientation, margin: 40 });
  pdf.pipe(res);

  // --- Geometría base y límites de contenido ---
  const MARGIN = 40;
  const LEFT   = MARGIN;
  const RIGHT  = pdf.page.width - MARGIN;
  const FOOTER_H = 70;
  const CONTENT_BOTTOM_MARGIN = 20;
  const contentBottom = () => pdf.page.height - (FOOTER_H + CONTENT_BOTTOM_MARGIN);

  // Header (devuelve Y de inicio de contenido)
  function drawHeader(firstPage = false) {
    const top = 20;

    // Logo (si existe)
    try {
      const pLogo = path.join(process.cwd(), 'public', 'imagenes', 'logoJOSG.png');
      if (fs.existsSync(pLogo)) pdf.image(pLogo, LEFT, top, { height: 40 });
    } catch {}

    // Web / correo
    pdf.font('Helvetica-Bold').fontSize(10)
       .text('www.josg.org', RIGHT - 160, top, { width: 160, align: 'right' });
    pdf.font('Helvetica').fontSize(9)
       .text('info@josg.org', RIGHT - 160, top + 14, { width: 160, align: 'right' });

    // Línea bajo cabecera
    pdf.save().moveTo(LEFT, top + 46).lineTo(RIGHT, top + 46)
       .strokeColor('#B0B0B0').stroke().restore();

    // === título + meta con altura real ===
    let contentTopY;
    if (firstPage) {
      const title = inf.informe || `Informe ${inf.id}`;
      const titleWidth = RIGHT - LEFT;

      pdf.font('Helvetica-Bold').fontSize(16);
      const titleH = pdf.heightOfString(title, { width: titleWidth });
      pdf.text(title, LEFT, top + 52, { width: titleWidth });

      // meta arranca justo debajo del título
      let metaY = top + 52 + titleH + 8;

      pdf.font('Helvetica').fontSize(10);
      const metaWidth = titleWidth;
      const put = (txt) => {
        const h = pdf.heightOfString(txt, { width: metaWidth });
        pdf.text(txt, LEFT, metaY, { width: metaWidth });
        metaY += Math.max(14, h);
      };
      put(`Fecha: ${formatDateSafe(inf.fecha)}`);
      if (showGroup && inf.grupo_nombre)            put(`Grupo: ${inf.grupo_nombre}`);
      if (showInstrument && inf.instrumento_nombre) put(`Instrumento: ${inf.instrumento_nombre}`);

      pdf.moveTo(LEFT, metaY + 16).lineTo(RIGHT, metaY + 16)
         .strokeColor('#E0E0E0').stroke();

      contentTopY = metaY + 22;
    } else {
      contentTopY = top + 56;
    }

    // Pie (fijo, sin empujar cursor)
    const bottomY = pdf.page.height - FOOTER_H + 10;

    pdf.save().moveTo(LEFT, bottomY).lineTo(RIGHT, bottomY)
       .strokeColor('#B0B0B0').stroke().restore();

    const hoy = new Date();
    const fechaGranada = `Granada, ${hoy.getDate()} de ${fmtMonth.format(hoy)} de ${hoy.getFullYear()}`;

    pdf.font('Helvetica').fontSize(9)
       .text(fechaGranada, LEFT, bottomY - 16, {
         width: RIGHT - LEFT, height: 14, ellipsis: true, lineBreak: false
       });

    const footerText = [
      'Asociación Joven Orquesta de Granada',
      'CIF: G-18651067 · www.josg.org · Tfno: 682445971',
      'C/ Andrés Segovia 60, 18007 Granada',
      'Sede de ensayos: Teatro Maestro Francisco Alonso, C/ Ribera del Beiro 34, 18012 Granada'
    ].join('\n');

    pdf.font('Helvetica').fontSize(8)
       .text(footerText, LEFT, bottomY + 6, {
         width: RIGHT - LEFT, height: FOOTER_H - 26, ellipsis: true, lineBreak: false
       });

    pdf.y = contentTopY;
    return contentTopY;
  }

  // === Primera página
  let y = drawHeader(true);

  // --- Geometría de la tabla (Alumno | [Grupo] | [Instrumento] | campos…) ---
  const hayAlumnos   = alumnosIds.length > 0;
  const includeGrupo = hayAlumnos && showGroup;
  const includeInst  = hayAlumnos && showInstrument;

  const colPrimW   = hayAlumnos ? 150 : 0; // si NO hay alumnos, no hay primera columna
  const colGrupoW  = includeGrupo ? 90 : 0;
  const colInstW   = includeInst  ? 90 : 0;

  const nColsDatos = camposV.length;
  const anchoTabla = (RIGHT - LEFT);
  const anchoRest  = anchoTabla - colPrimW - colGrupoW - colInstW;
  const colW       = Math.max(70, Math.floor(anchoRest / Math.max(1, nColsDatos)));
  const rowH       = 18;

  const drawTableHeader = () => {
    let x = LEFT;
    const totalW = (hayAlumnos ? colPrimW : 0) + colGrupoW + colInstW + colW * nColsDatos;

    pdf.rect(LEFT, y, totalW, rowH).stroke();
    pdf.font('Helvetica-Bold').fontSize(10);

    if (hayAlumnos) {
      pdf.text('Músico', x + 4, y + 4, { width: colPrimW - 8, height: rowH - 8, ellipsis: true, lineBreak: false });
      x += colPrimW;
    }
    if (includeGrupo) {
      pdf.text('Grupo', x + 4, y + 4, { width: colGrupoW - 8, height: rowH - 8, ellipsis: true, lineBreak: false });
      x += colGrupoW;
    }
    if (includeInst) {
      pdf.text('Instrumento', x + 4, y + 4, { width: colInstW - 8, height: rowH - 8, ellipsis: true, lineBreak: false });
      x += colInstW;
    }

    for (const c of camposV) {
      pdf.text(c.nombre, x + 4, y + 4, { width: colW - 8, height: rowH - 8, ellipsis: true, lineBreak: false });
      x += colW;
    }

    y += rowH + 2;
    pdf.font('Helvetica').fontSize(10);
  };

  const needNewPage = () => (y + rowH) > contentBottom();
  const newPageWithHeader = () => { pdf.addPage(); y = drawHeader(false); drawTableHeader(); };

  drawTableHeader();

  // --- Filas ---
  if (filas.length === 0 || nColsDatos === 0) {
    pdf.font('Helvetica-Oblique').text('No hay datos para mostrar.', LEFT, y);
  } else {
    for (const f of filas) {
      if (needNewPage()) newPageWithHeader();

      const totalW = (hayAlumnos ? colPrimW : 0) + colGrupoW + colInstW + colW * nColsDatos;
      pdf.rect(LEFT, y - 2, totalW, rowH).stroke();

      let x = LEFT;

      // Primera col: solo si hay alumnos
      if (hayAlumnos) {
        const etiqueta = nombreAlumno.get(String(f.alumnoId)) || `Músico ${f.alumnoId ?? '-'}`;
        pdf.text(String(etiqueta), x + 4, y + 2, { width: colPrimW - 8, height: rowH - 4, ellipsis: true, lineBreak: false });
        x += colPrimW;
      }

      if (includeGrupo) {
        const gStr = (f.alumnoId != null) ? (gruposAlumno.get(String(f.alumnoId)) || '—') : '—';
        pdf.text(gStr, x + 4, y + 2, { width: colGrupoW - 8, height: rowH - 4, ellipsis: true, lineBreak: false });
        x += colGrupoW;
      }

      if (includeInst) {
        const iStr = (f.alumnoId != null) ? (instrAlumno.get(String(f.alumnoId)) || '—') : '—';
        pdf.text(iStr, x + 4, y + 2, { width: colInstW - 8, height: rowH - 4, ellipsis: true, lineBreak: false });
        x += colInstW;
      }

      // Campos del informe
      for (const c of camposV) {
        let v = f.c.get(c.id) ?? '';
        const t = (c.tipo || '').toLowerCase();
        if (t.includes('bool') || t === 'booleano') {
          const s = String(v).trim().toLowerCase();
          v = (s === '1' || s === 'true' || s === 't' || s === 'sí' || s === 'si' || s === 'x') ? 'Sí'
            : (s === '' || s === 'null' || s === 'undefined' ? '' : 'No');
        } else if (t.includes('numero') || t.includes('num')) {
          const n = Number(v); v = Number.isFinite(n) ? n.toString().replace('.', ',') : (v ?? '');
        }
        pdf.text(String(v), x + 4, y + 2, { width: colW - 8, height: rowH - 4, ellipsis: true, lineBreak: false });
        x += colW;
      }

      y += rowH;
    }
  }

  pdf.end();
}

/* ======================== Rutas ======================== */

// Ver PDF interno por ID (añade tu middleware de auth si procede)
router.get('/pdf/informe/:id', async (req, res, next) => {
  try {
    await streamInformePDF(res, req.params.id, {
      showGroup:      parseBoolQS(req.query.showGroup),
      showInstrument: parseBoolQS(req.query.showInstrument)
    });
  } catch (e) { console.error('PDF ERROR /pdf/informe/:id', e); next(e); }
});

// Generar slug público
router.post('/api/informes/:id/slug', async (req, res, next) => {
  try {
    await ensurePublicSlugColumn();
    const { id } = req.params;
    const slug = crypto.randomBytes(16).toString('hex');
    const { rowCount } = await pool.query(
      'UPDATE informes SET public_slug = $1 WHERE id = $2',
      [slug, id]
    );
    if (!rowCount) return res.status(404).json({ ok:false, msg:'Informe no encontrado' });

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const url = `${proto}://${req.get('host')}/i/${slug}.pdf`;
    res.json({ ok:true, slug, url });
  } catch (e) { console.error('PDF ERROR POST slug', e); next(e); }
});

// Revocar slug público
router.delete('/api/informes/:id/slug', async (req, res, next) => {
  try {
    await ensurePublicSlugColumn();
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'UPDATE informes SET public_slug = NULL WHERE id = $1',
      [id]
    );
    if (!rowCount) return res.status(404).json({ ok:false, msg:'Informe no encontrado' });
    res.json({ ok:true });
  } catch (e) { console.error('PDF ERROR DELETE slug', e); next(e); }
});

// Público: ver PDF por slug (sin sesión)
router.get('/i/:slug.pdf', async (req, res, next) => {
  try {
    await ensurePublicSlugColumn();
    const { rows: [inf] } = await pool.query(
      'SELECT id FROM informes WHERE public_slug = $1',
      [req.params.slug]
    );
    if (!inf) return res.status(404).send('Informe no encontrado o enlace revocado');

    await streamInformePDF(res, inf.id, {
      showGroup:      parseBoolQS(req.query.showGroup),
      showInstrument: parseBoolQS(req.query.showInstrument)
    });
  } catch (e) { console.error('PDF ERROR /i/:slug.pdf', e); next(e); }
});

module.exports = router;
