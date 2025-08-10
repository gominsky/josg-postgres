// /utils/pdfControlAsistencia.js
const PDFDocument = require('pdfkit');
const { drawHeader, drawFooter } = require('./pdfHeaderFooter');

/**
 * Genera y envía el PDF de Control de Asistencia.
 * - Carga evento + grupo, alumnos del grupo y asistencias (firmados)
 * - Maqueta cabecera, tabla paginada y pie con número de página
 *
 * @param {Pool|Client} db  - Conexión/Postgres (objeto con .query)
 * @param {Response}    res - Express response
 * @param {number}      eventoId
 */
async function pdfControlAsistencia(db, res, eventoId) {
  // --------- CARGA DE DATOS ----------
  // Evento + grupo (sin e.referencia)
  const evRes = await db.query(
    `SELECT e.id, e.titulo, e.fecha_inicio, e.fecha_fin, e.hora_inicio, e.hora_fin,
            e.grupo_id, g.nombre AS grupo_nombre
       FROM eventos e
       JOIN grupos g ON g.id = e.grupo_id
      WHERE e.id = $1`,
    [eventoId]
  );
  if (evRes.rows.length === 0) {
    const err = new Error('Evento no encontrado');
    err.status = 404;
    throw err;
  }
  const evento = evRes.rows[0];

  // Alumnos del grupo
  const alRes = await db.query(
    `SELECT a.id, a.nombre, a.apellidos, a.dni
       FROM alumnos a
       JOIN alumno_grupo ag ON ag.alumno_id = a.id
      WHERE ag.grupo_id = $1
      ORDER BY a.apellidos NULLS LAST, a.nombre NULLS LAST, a.id`,
    [evento.grupo_id]
  );
  const alumnos = alRes.rows;
  const coll = new Intl.Collator('es', { sensitivity: 'base' });
  alumnos.sort((a, b) => {
    const ap = coll.compare(a.apellidos || '', b.apellidos || '');
    if (ap) return ap;
    const no = coll.compare(a.nombre || '', b.nombre || '');
    if (no) return no;
    return (a.id || 0) - (b.id || 0);
  });

  // Firmados (alumnos con asistencia registrada para este evento)
  const asisRes = await db.query(
    `SELECT DISTINCT alumno_id FROM asistencias WHERE evento_id = $1`,
    [eventoId]
  );
  const firmados = asisRes.rows.map(r => Number(r.alumno_id));

  // --------- CONFIG PDF ----------
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 40, right: 40 }
  });

  // contador de páginas propio
  let pageNum = 1;
  doc.on('pageAdded', () => { pageNum += 1; });

  // cabeceras HTTP y pipe
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="firmas_evento_${evento.id}.pdf"`);
  doc.pipe(res);

  // reservas para header/footer (ajusta si cambias el pie)
  const HEADER_H = 80;   // alto aproximado del header (logo + título)
  const FOOTER_H = 90;   // debe ser coherente con tu drawFooter
  const CONTENT_TOP = () => doc.page.margins.top + HEADER_H;
  const CONTENT_BOTTOM = () => doc.page.height - doc.page.margins.bottom - FOOTER_H;
  const INNER_W = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // columnas de la tabla (proporciones)
  const colsForWidth = (w) => ({
    nombre: Math.floor(w * 0.58),
    dni:    Math.floor(w * 0.22),
    firm:   Math.floor(w * 0.20),
  });

  // --------- DIBUJO DE ESTRUCTURA ----------
  function drawTableHeader() {
    const innerW = INNER_W();
    const cols = colsForWidth(innerW);

    const HEADER_ROW_H = 22;
    ensureSpace(HEADER_ROW_H + 4, false); // asegúrate de que cabe el header de tabla

    const y = doc.y;
    doc.save();
    doc.rect(doc.page.margins.left, y, innerW, HEADER_ROW_H).fill('#eeeeee');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(10);

    let x = doc.page.margins.left + 8;
    doc.text('Nombre completo', x, y + 6, { width: cols.nombre - 16, align: 'left' }); x += cols.nombre;
    doc.text('DNI',             x + 8, y + 6, { width: cols.dni - 16, align: 'left' }); x += cols.dni;
    doc.text('Firmado',         x + 8, y + 6, { width: cols.firm - 16, align: 'left' });
    doc.restore();

    doc.moveTo(doc.page.margins.left, y + HEADER_ROW_H)
       .lineTo(doc.page.margins.left + innerW, y + HEADER_ROW_H)
       .strokeColor('#c9ced6').stroke();

    doc.y = y + HEADER_ROW_H;
  }

  function ensureSpace(needed, addHeader = true) {
    if (doc.y + needed > CONTENT_BOTTOM()) {
      // cerrar página actual y abrir nueva
      drawFooter(doc, pageNum);
      doc.addPage();
      drawHeader(doc, null); // no usamos referencia
      doc.y = CONTENT_TOP();
      if (addHeader) drawTableHeader();
    }
  }

  // --------- PRIMERA PÁGINA ----------
  drawHeader(doc, null); // no usamos referencia
  doc.y = CONTENT_TOP();

  // Título + datos (sin posiciones absolutas que rompan el flujo)
  doc.fontSize(16).font('Helvetica-Bold')
     .text('CONTROL DE ASISTENCIA', { align: 'center' })
     .moveDown(0.5);

  const fecha = (evento.fecha_inicio || '').toString().split('T')[0] || '—';
  const hIni  = (evento.hora_inicio || '').slice(0, 5) || '—';
  const hFin  = (evento.hora_fin || '').slice(0, 5) || '—';

  doc.fontSize(11).font('Helvetica')
     .text(`Evento: ${evento.titulo} (${evento.grupo_nombre})`, { align: 'center' })
     .text(`Fecha: ${fecha}    Hora: ${hIni} - ${hFin}`,         { align: 'center' })
     .moveDown(0.8);

  drawTableHeader();

  // --------- FILAS DE LA TABLA ----------
  doc.font('Helvetica').fontSize(10).fillColor('#000');
  const PAD = 6;
  const BASE_LINE = 14;

  for (const al of alumnos) {
    const innerW = INNER_W();
    const cols = colsForWidth(innerW);

    const nombre  = `${al.apellidos || ''}, ${al.nombre || ''}`.trim();
    const dni     = al.dni || '';
    const firmado = firmados.includes(al.id);

    // altura dinámica según wraps
    const hNombre = doc.heightOfString(nombre, { width: cols.nombre - 2 * PAD });
    const hDni    = doc.heightOfString(dni,    { width: cols.dni    - 2 * PAD });
    const rowH    = Math.max(BASE_LINE, Math.ceil(Math.max(hNombre, hDni) / BASE_LINE) * BASE_LINE) + PAD;

    ensureSpace(rowH + 4); // respeta el footer

    const y = doc.y;
    doc.strokeColor('#c9ced6').rect(doc.page.margins.left, y, innerW, rowH).stroke();

    let x = doc.page.margins.left + PAD;
    doc.text(nombre, x, y + PAD / 2, { width: cols.nombre - 2 * PAD });
    x += cols.nombre;
    doc.text(dni, x + PAD, y + PAD / 2, { width: cols.dni - 2 * PAD });
    x += cols.dni;

    // casilla de firmado + check con líneas (sin unicode)
    const box = 12;
    const boxY = y + (rowH - box) / 2;
    doc.rect(x + PAD, boxY, box, box).stroke();
    if (firmado) {
      doc.moveTo(x + PAD + 2,        boxY + box / 2)
         .lineTo(x + PAD + box / 3,  boxY + box - 2)
         .lineTo(x + PAD + box - 2,  boxY + 2)
         .strokeColor('#2e7d32').lineWidth(2).stroke()
         .lineWidth(1).strokeColor('#c9ced6');
    }

    doc.y = y + rowH;
  }

  // --------- CIERRE ----------
  drawFooter(doc, pageNum); // pasamos nuestro contador
  doc.end();
}

module.exports = { pdfControlAsistencia };
