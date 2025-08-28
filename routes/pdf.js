// routes/pdf.js
const { Router } = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const pool = require('../database/db'); // ajusta si tu pool está en otra ruta

const router = Router();

/* ========= Helpers ========= */

// Resuelve nombres de alumnos si existe la tabla; si no, muestra "Alumno <id>"
async function getAlumnosNombres(ids) {
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query(`
      SELECT id, COALESCE(TRIM(nombre || ' ' || apellidos), nombre::text, id::text) AS nombre
      FROM alumnos
      WHERE id = ANY($1::int[])
    `, [ids]);
    const m = new Map();
    rows.forEach(r => m.set(r.id, r.nombre || `Alumno ${r.id}`));
    return m;
  } catch {
    const m = new Map();
    ids.forEach(id => m.set(id, `Alumno ${id}`));
    return m;
  }
}

// ⚙️ Función completa: genera el PDF al vuelo con datos reales
async function streamInformePDF(res, informeId) {
  
  // 1) Datos base del informe
  const { rows: [inf] } = await pool.query(`
    SELECT id, informe, fecha, observaciones
    FROM informes
    WHERE id = $1
  `, [informeId]);
  if (!inf) { res.status(404).send('Informe no encontrado'); return; }

  // 2) Definición de campos (columnas)
  const { rows: campos } = await pool.query(`
    SELECT id, nombre, tipo, obligatorio
    FROM informe_campos
    WHERE informe_id = $1
    ORDER BY id
  `, [informeId]);

  // 3) Resultados (celdas)
  const { rows: resultados } = await pool.query(`
    SELECT alumno_id, campo_id, valor, fila
    FROM informe_resultados
    WHERE informe_id = $1
    ORDER BY COALESCE(fila, 2147483647), alumno_id, campo_id
  `, [informeId]);

  // 4) Caché del navegador (ETag sencillo sin depender de updated_at)
  const etagBase = JSON.stringify({
  f: isoDateSafe(inf.fecha),
  nC: campos.length,
  nR: resultados.length
});
const etag = crypto.createHash('sha1').update(etagBase).digest('hex');

  if (res.req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=86400'); // 1 día

  // 5) Cabeceras para ver inline
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="informe-${informeId}.pdf"`);

  // 6) Preparación de filas (pivot por alumno_id y/o fila)
  const alumnosIds = [...new Set(resultados.map(r => r.alumno_id).filter(v => v !== null))];
  const nombreAlumno = await getAlumnosNombres(alumnosIds);

  const porFila = new Map(); // clave: string "alumnoId|fila"
  for (const r of resultados) {
    const key = `${r.alumno_id ?? 'null'}|${r.fila ?? 999999}`;
    if (!porFila.has(key)) {
      porFila.set(key, {
        alumnoId: r.alumno_id,           // puede ser null
        fila:     r.fila ?? 999999,
        c:        new Map()              // campo_id -> valor
      });
    }
    porFila.get(key).c.set(r.campo_id, r.valor);
  }
  const filas = [...porFila.values()].sort((a, b) =>
    a.fila - b.fila || (a.alumnoId ?? 0) - (b.alumnoId ?? 0)
  );

  // 7) Crear el PDF **ANTES** de acceder a pdf.page.*
  const orientation = campos.length > 6 ? 'landscape' : 'portrait';
  const pdf = new PDFDocument({ size: 'A4', layout: orientation, margin: 40 });
  pdf.pipe(res);

  // 8) Encabezado
  const fmtDate = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' });

function toDateSafe(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateSafe(v) {
  const d = toDateSafe(v);
  return d ? fmtDate.format(d) : '-';
}

function isoDateSafe(v) {
  const d = toDateSafe(v);
  return d ? d.toISOString().slice(0, 10) : null; // YYYY-MM-DD
}

  pdf.font('Helvetica-Bold').fontSize(18)
     .text(inf.informe || `Informe ${inf.id}`, { align: 'left' });

  pdf.moveDown(0.5).font('Helvetica').fontSize(10)
   .text(`Fecha: ${formatDateSafe(inf.fecha)}`);

  if (inf.observaciones) {
    pdf.moveDown(0.5).font('Helvetica-Oblique')
       .text(`Observaciones: ${inf.observaciones}`);
    pdf.font('Helvetica');
  }
  pdf.moveDown();

  // 9) Geometría de la tabla
  const pageW = pdf.page.width;
  const pageH = pdf.page.height;
  const left  = 40;
  const right = pageW - 40;

  const hayAlumnos = alumnosIds.length > 0;
  const colPrimLabel = hayAlumnos ? 'Alumno' : 'Fila';
  const colPrimW  = hayAlumnos ? 160 : 60;

  const nCols = campos.length;
  const anchoTabla = (right - left);
  const anchoResto = Math.max(120, anchoTabla - colPrimW);
  const colW = Math.max(80, Math.floor(anchoResto / Math.max(1, nCols)));

  // 10) Pintar cabecera de la tabla
  let x = left;
  let y = pdf.y;
  const rowH = 18;

  pdf.rect(left, y, colPrimW + colW * nCols, rowH).stroke();
  pdf.font('Helvetica-Bold').fontSize(10)
     .text(colPrimLabel, x + 4, y + 4, { width: colPrimW - 8 });
  x += colPrimW;

  for (const c of campos) {
    pdf.text(c.nombre, x + 4, y + 4, { width: colW - 8, ellipsis: true });
    x += colW;
  }

  y += rowH + 2;
  pdf.font('Helvetica').fontSize(10);

  function newPageWithHeader() {
    pdf.addPage();
    x = left; y = 40;

    pdf.rect(left, y, colPrimW + colW * nCols, rowH).stroke();
    pdf.font('Helvetica-Bold').fontSize(10)
       .text(colPrimLabel, left + 4, y + 4, { width: colPrimW - 8 });

    let cx = left + colPrimW;
    for (const c of campos) {
      pdf.text(c.nombre, cx + 4, y + 4, { width: colW - 8, ellipsis: true });
      cx += colW;
    }
    y += rowH + 2;
    pdf.font('Helvetica').fontSize(10);
  }

  // 11) Filas
  if (filas.length === 0) {
    pdf.font('Helvetica-Oblique').text('No hay datos para mostrar.');
  } else {
    for (const f of filas) {
      if (y > pageH - 60) newPageWithHeader();
      x = left;

      // marco de fila
      pdf.rect(left, y - 2, colPrimW + colW * nCols, rowH).stroke();

      // Primera columna: Alumno o Fila
      const etiqueta = hayAlumnos
        ? (nombreAlumno.get(f.alumnoId) || `Alumno ${f.alumnoId ?? '-'}`)
        : String(f.fila);
      pdf.text(etiqueta, x + 4, y + 2, { width: colPrimW - 8 });
      x += colPrimW;

      // Columnas dinámicas
      for (const c of campos) {
        let v = f.c.get(c.id) ?? '';
        const tipo = (c.tipo || '').toLowerCase();

        // Formateos básicos
        if (tipo.includes('bool') || tipo === 'booleano') {
          const s = String(v).trim().toLowerCase();
          v = (s === '1' || s === 'true' || s === 't' || s === 'sí' || s === 'si' || s === 'x') ? 'Sí'
            : (s === '' || s === 'null' || s === 'undefined' ? '' : 'No');
        } else if (tipo.includes('numero') || tipo.includes('num')) {
          const n = Number(v);
          v = Number.isFinite(n) ? n.toString().replace('.', ',') : (v ?? '');
        }

        pdf.text(String(v), x + 4, y + 2, { width: colW - 8, ellipsis: true });
        x += colW;
      }

      y += rowH;
    }
  }

  // 12) Pie de página
  if (y < pageH - 40) {
    pdf.moveTo(left, pageH - 60).lineTo(right, pageH - 60).stroke();
    pdf.font('Helvetica').fontSize(8)
       .text(`Generado: ${new Date().toLocaleString('es-ES')} — Informe #${inf.id}`, left, pageH - 50);
  }

  pdf.end();
}

/* ========= Rutas ========= */
// Ver PDF al vuelo por ID
router.get('/pdf/informe/:id', async (req, res, next) => {
  try { await streamInformePDF(res, req.params.id); }
  catch (e) { console.error('PDF ERROR /pdf/informe/:id', e); next(e); }
});

// Generar o regenerar slug público (sin updated_at para evitar errores)
router.post('/api/informes/:id/slug', async (req, res, next) => {
  try {
    const { id } = req.params;
    const slug = crypto.randomBytes(16).toString('hex'); // 32 chars
    const { rowCount } = await pool.query(
      'UPDATE informes SET public_slug = $1 WHERE id = $2',
      [slug, id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, msg: 'Informe no encontrado' });
    const url = `${req.protocol}://${req.get('host')}/i/${slug}.pdf`;
    res.json({ ok: true, slug, url });
  } catch (e) { console.error('PDF ERROR POST slug', e); next(e); }
});

// Revocar slug
router.delete('/api/informes/:id/slug', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'UPDATE informes SET public_slug = NULL WHERE id = $1',
      [id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, msg: 'Informe no encontrado' });
    res.json({ ok: true });
  } catch (e) { console.error('PDF ERROR DELETE slug', e); next(e); }
});

// Público: ver PDF por slug
router.get('/i/:slug.pdf', async (req, res, next) => {
  try {
    const { rows: [inf] } = await pool.query(
      'SELECT id FROM informes WHERE public_slug = $1',
      [req.params.slug]
    );
    if (!inf) return res.status(404).send('Informe no encontrado o enlace revocado');
    await streamInformePDF(res, inf.id);
  } catch (e) { console.error('PDF ERROR /i/:slug.pdf', e); next(e); }
});

module.exports = router;

