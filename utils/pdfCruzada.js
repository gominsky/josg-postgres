// utils/pdfCruzada.js
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const dayjs       = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

/* ── Header / Footer idénticos a pdfGuardias ── */
function drawHeader(doc, { desde, hasta, grupoNombre }) {
  const logoPath = './public/imagenes/logoJOSG.png';
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 40, 20, { height: 50 });
  }
  const rango = `${dayjs(desde).format('DD/MM/YYYY')} – ${dayjs(hasta).format('DD/MM/YYYY')}`;
  const grupo = grupoNombre || 'Todos los grupos';
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#222')
     .text(`Tabla de asistencias a guardias`, 40, 80, { lineBreak: false });
  doc.fontSize(9).font('Helvetica').fillColor('#555')
     .text(`Periodo: ${rango}   ·   Grupo: ${grupo}`, 40, 96, { lineBreak: false });
  // Reposicionar cursor justo debajo del header para que pintarBloque empiece bien
  doc.y = 115;
}

function drawFooter(doc) {
  const pageW = doc.page.width;
  const now   = new Date();
  const fecha = `${now.getDate()} de ${now.toLocaleString('es-ES', { month: 'long' })} de ${now.getFullYear()}`;
  doc.save();
  doc.moveTo(40, doc.page.height - 60).lineTo(pageW - 40, doc.page.height - 60).stroke();
  doc.fontSize(9).fillColor('gray')
     .text(`Granada, ${fecha}`, 40, doc.page.height - 54, { lineBreak: false });
  doc.fontSize(7).fillColor('gray')
     .text(
       `Asociación Joven Orquesta de Granada · CIF: G-18651067 · www.josg.org · info@josg.org · Tfno: 682445971\n` +
       `C/ Andrés Segovia 60, 18007 Granada`,
       40, doc.page.height - 44, { lineBreak: false }
     );
  doc.restore();
}

/* ── Generador principal ── */
function generarPdfCruzada(res, { alumnos, eventos, matriz, desde, hasta, grupoNombre }) {
  // Landscape A4 para que quepan más columnas
  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Disposition', 'attachment; filename="tabla_asistencias_guardias.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  drawHeader(doc, { desde, hasta, grupoNombre });
  drawFooter(doc);
  doc.on('pageAdded', () => {
    drawHeader(doc, { desde, hasta, grupoNombre });
    drawFooter(doc);
  });

  if (!alumnos.length || !eventos.length) {
    doc.fontSize(11).fillColor('#555').text('No hay datos para mostrar.', 40, 130);
    doc.end();
    return;
  }

  const pageW   = doc.page.width;   // 841 landscape
  const marginL = 40;
  const marginR = 40;
  const usableW = pageW - marginL - marginR;

  /* ── Cálculo de anchos de columna ──
     Col 0: nombre músico  (fija 130px)
     Col 1: total          (fija 38px)
     Resto: eventos        (reparto equitativo del espacio libre)
  */
  const COL_ALUMNO = 130;
  const COL_TOTAL  = 38;
  const nEventos   = eventos.length;

  // Si caben todos en una página, los repartimos; si no, los truncamos a 72px mínimo
  let colEv = Math.max(22, Math.floor((usableW - COL_ALUMNO - COL_TOTAL) / nEventos));
  // Máximo de eventos por página
  const maxEvPorPag = Math.floor((usableW - COL_ALUMNO - COL_TOTAL) / colEv);

  /* ── Formato fecha corto ── */
  const fmtCorto = s => {
    if (!s) return '';
    const d = dayjs(s);
    return d.isValid() ? d.format('DD/MM') : String(s).slice(5, 10).replace('-', '/');
  };

  /* ── Altura de filas ── */
  const ROW_H_HEADER = 36; // doble línea (fecha + nombre evento)
  const ROW_H_DATA   = 16;
  const ROW_H_FOOT   = 16;
  const HEADER_Y     = 115;
  const LIMIT_Y      = doc.page.height - 70;

  /* ── Colores ── */
  const C_HEADER_BG  = '#1a1a1a';
  const C_HEADER_TXT = '#ffffff';
  const C_TOTAL_BG   = '#2a2a2a';
  const C_MARK_NRM   = '#e87722'; // naranja guardia normal
  const C_MARK_ACT   = '#2e7d32'; // verde guardia actividad
  const C_ALT_ROW    = '#fafafa';
  const C_FOOT_BG    = '#f0f0f0';

  /* ── Pintar un bloque de páginas (slice de eventos) ── */
  function pintarBloque(evSlice, startX, isFirstBloque) {
    const nCols = evSlice.length;
    let y = HEADER_Y;

    /* Cabecera */
    // Fondo negro en col alumno y total
    doc.rect(startX, y, COL_ALUMNO, ROW_H_HEADER).fill(C_HEADER_BG);
    doc.rect(startX + COL_ALUMNO, y, COL_TOTAL, ROW_H_HEADER).fill(C_TOTAL_BG);
    // Fondo negro eventos
    evSlice.forEach((_, i) => {
      doc.rect(startX + COL_ALUMNO + COL_TOTAL + i * colEv, y, colEv, ROW_H_HEADER)
         .fill(C_HEADER_BG);
    });

    // Textos cabecera
    doc.fontSize(7).font('Helvetica-Bold').fillColor(C_HEADER_TXT);
    doc.text('Músico', startX + 3, y + 4, { width: COL_ALUMNO - 4 });
    doc.text('Total', startX + COL_ALUMNO + 2, y + 13, { width: COL_TOTAL - 2, align: 'center' });

    evSlice.forEach((ev, i) => {
      const xEv = startX + COL_ALUMNO + COL_TOTAL + i * colEv;
      const fecha  = fmtCorto(ev.fecha_inicio);
      const titulo = ev.titulo.length > 12 ? ev.titulo.slice(0, 11) + '…' : ev.titulo;
      doc.fontSize(6).font('Helvetica-Bold').fillColor(C_HEADER_TXT)
         .text(fecha,  xEv + 1, y + 4,  { width: colEv - 2, align: 'center' })
         .text(titulo, xEv + 1, y + 14, { width: colEv - 2, align: 'center' });
    });

    y += ROW_H_HEADER;

    /* Filas de datos */
    alumnos.forEach((alumno, rowIdx) => {
      if (y + ROW_H_DATA > LIMIT_Y) {
        doc.addPage();
        y = HEADER_Y;
        pintarCabeceraSimple(evSlice, startX, y);
        y += ROW_H_HEADER;
      }

      const bg = rowIdx % 2 === 0 ? '#ffffff' : C_ALT_ROW;
      const totalAlumno = evSlice.filter(ev => matriz[alumno.id]?.[ev.id]).length;

      // Fondo fila
      doc.rect(startX, y, COL_ALUMNO + COL_TOTAL + nCols * colEv, ROW_H_DATA).fill(bg);

      // Bordes
      doc.rect(startX, y, COL_ALUMNO, ROW_H_DATA).stroke();
      doc.rect(startX + COL_ALUMNO, y, COL_TOTAL, ROW_H_DATA).stroke();

      // Nombre músico
      const nombre = `${alumno.apellidos}, ${alumno.nombre}`;
      doc.fontSize(7).font('Helvetica').fillColor('#111')
         .text(nombre, startX + 3, y + 4, { width: COL_ALUMNO - 5, ellipsis: true });

      // Total
      doc.fontSize(7).font('Helvetica-Bold')
         .fillColor(totalAlumno > 0 ? C_MARK_NRM : '#aaa')
         .text(String(totalAlumno), startX + COL_ALUMNO + 2, y + 4,
               { width: COL_TOTAL - 4, align: 'center' });

      // Celdas eventos
      evSlice.forEach((ev, i) => {
        const xEv = startX + COL_ALUMNO + COL_TOTAL + i * colEv;
        doc.rect(xEv, y, colEv, ROW_H_DATA).stroke();

        const g = matriz[alumno.id]?.[ev.id];
        if (g) {
          const esAct = g.tipo === 'actividad';
          const color = esAct ? C_MARK_ACT : C_MARK_NRM;
          const label = esAct ? (g.subtipo || 'A').slice(0, 4) : '✓';
          // Cuadradito de color
          const mW = Math.min(colEv - 4, 18), mH = 10;
          const mX = xEv + (colEv - mW) / 2;
          const mY = y + (ROW_H_DATA - mH) / 2;
          doc.rect(mX, mY, mW, mH).fill(color);
          doc.fontSize(5.5).font('Helvetica-Bold').fillColor('#fff')
             .text(label, mX, mY + 1.5, { width: mW, align: 'center' });
        }
      });

      y += ROW_H_DATA;
    });

    /* Fila de totales por evento */
    if (y + ROW_H_FOOT <= LIMIT_Y) {
      doc.rect(startX, y, COL_ALUMNO + COL_TOTAL + nCols * colEv, ROW_H_FOOT).fill(C_FOOT_BG);
      doc.rect(startX, y, COL_ALUMNO, ROW_H_FOOT).stroke();
      doc.rect(startX + COL_ALUMNO, y, COL_TOTAL, ROW_H_FOOT).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#333')
         .text('Total músicos', startX + 3, y + 4, { width: COL_ALUMNO - 4 });

      evSlice.forEach((ev, i) => {
        const xEv  = startX + COL_ALUMNO + COL_TOTAL + i * colEv;
        const tot  = alumnos.filter(a => matriz[a.id]?.[ev.id]).length;
        doc.rect(xEv, y, colEv, ROW_H_FOOT).stroke();
        if (tot > 0) {
          doc.fontSize(7).font('Helvetica-Bold').fillColor(C_MARK_NRM)
             .text(String(tot), xEv, y + 4, { width: colEv, align: 'center' });
        }
      });
    }
  }

  /* Cabecera simplificada para páginas de continuación */
  function pintarCabeceraSimple(evSlice, startX, y) {
    doc.rect(startX, y, COL_ALUMNO, ROW_H_HEADER).fill(C_HEADER_BG);
    doc.rect(startX + COL_ALUMNO, y, COL_TOTAL, ROW_H_HEADER).fill(C_TOTAL_BG);
    evSlice.forEach((ev, i) => {
      doc.rect(startX + COL_ALUMNO + COL_TOTAL + i * colEv, y, colEv, ROW_H_HEADER).fill(C_HEADER_BG);
    });
    doc.fontSize(7).font('Helvetica-Bold').fillColor(C_HEADER_TXT)
       .text('Músico', startX + 3, y + 4, { width: COL_ALUMNO - 4 })
       .text('Total', startX + COL_ALUMNO + 2, y + 13, { width: COL_TOTAL - 2, align: 'center' });
    evSlice.forEach((ev, i) => {
      const xEv = startX + COL_ALUMNO + COL_TOTAL + i * colEv;
      doc.fontSize(6).font('Helvetica-Bold').fillColor(C_HEADER_TXT)
         .text(fmtCorto(ev.fecha_inicio), xEv + 1, y + 4,  { width: colEv - 2, align: 'center' })
         .text((ev.titulo || '').slice(0, 11), xEv + 1, y + 14, { width: colEv - 2, align: 'center' });
    });
  }

  /* ── Paginar eventos en bloques si no caben todos ── */
  if (nEventos <= maxEvPorPag) {
    pintarBloque(eventos, marginL, true);
  } else {
    let offset = 0;
    let primer  = true;
    while (offset < nEventos) {
      const slice = eventos.slice(offset, offset + maxEvPorPag);
      if (!primer) doc.addPage();
      pintarBloque(slice, marginL, primer);
      primer  = false;
      offset += maxEvPorPag;
    }
  }

  doc.end();
}

module.exports = { generarPdfCruzada };
