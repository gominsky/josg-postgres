// utils/pdfGuardias.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const dayjs = require('dayjs');
require('dayjs/locale/es');
dayjs.locale('es');

function drawHeader(doc, { desde, hasta, grupoNombre }) {
  const logoPath = './public/imagenes/logoJOSG.png';
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 40, 30, { height: 60 });
  }
  doc.fontSize(10).font('Helvetica-Bold').text('www.josg.org', 460, 30, { align: 'right' });
  doc.font('Helvetica').text('info@josg.org', 460, 45, { align: 'right' });
  doc.fontSize(14).fillColor('#222')
     .text(`Guardias entre ${dayjs(desde).format('DD/MM/YYYY')} y ${dayjs(hasta).format('DD/MM/YYYY')} - Grupo: ${grupoNombre}`, 40, 100);
}

function drawFooter(doc) {
  const now = new Date();
  const fecha = `${now.getDate()} de ${now.toLocaleString('es-ES', { month: 'long' })} de ${now.getFullYear()}`;
  doc.moveTo(40, 730).lineTo(555, 730).stroke();
  doc.fontSize(9).fillColor('gray').text(`Granada, ${fecha}`, 40, 735);
  doc.fontSize(7).fillColor('gray').text(
    `Asociación Joven Orquesta de Granada\nCIF: G-18651067 · www.josg.org · Tfno: 682445971\n` +
    `C/ Andrés Segovia 60, 18007 Granada\nSede de ensayos: Teatro Maestro Francisco Alonso, C/ Ribera del Beiro 34, 18012 Granada`,
    40, 750
  );
}

// --- helpers tabla ---
function drawTableHeader(doc, y) {
  // Anchuras nuevas
  const x = 40;
  const totalW = 500;
  const cols = [
    { key: 'fecha',    title: 'Fecha',    x: x + 5,   width: 70 },
    { key: 'grupo',    title: 'Grupo',    x: x + 75,  width: 100 },
    { key: 'evento',   title: 'Evento',   x: x + 175, width: 90 },
    { key: 'guardias', title: 'Guardias', x: x + 265, width: 240 }
  ];
  doc.rect(x, y, totalW, 18).fill('#eee').stroke();
  doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
  cols.forEach(c => doc.text(c.title, c.x, y + 4, { width: c.width }));
  return cols;
}

// ⚠️ IMPORTANTE: no usar doc._font (propiedad interna). Trabajamos con Helvetica fija.
function heightOfCell(doc, text, width) {
  const size = 9;
  // medimos con Helvetica a 9pt, que es lo que usamos al pintar
  doc.font('Helvetica').fontSize(size);
  const h = doc.heightOfString(text || '', { width });
  return h;
}

function renderMonthCalendar(doc, { year, month, eventosMes, desde, hasta, grupoNombre }) {
  const primerDia = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const ultimoDia = primerDia.endOf('month');

  const margenX = 40;
  const margenY = 150;
  const ancho = 520;
  const alto = 320;
  const diasSemana = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const cellWidth = ancho / 7;
  const cellHeight = alto / 6;

  // Cabecera calendario
  diasSemana.forEach((d, i) => {
    doc.fontSize(10).fillColor('black').text(d, margenX + i * cellWidth + 5, margenY - 15);
  });

  let fila = 0;
  let columna = (primerDia.day() + 6) % 7; // 0-dom → 6; 1-lun → 0
  for (let dia = 1; dia <= ultimoDia.date(); dia++) {
    const x = margenX + columna * cellWidth;
    const y = margenY + fila * cellHeight;

    doc.rect(x, y, cellWidth, cellHeight).stroke();
    doc.fontSize(8).fillColor('black').text(String(dia), x + 2, y + 2);

    const delDia = eventosMes.filter(ev => ev.dia === dia);
    delDia.forEach((eventoDia, idx) => {
      const texto = `${eventoDia.evento}\n${eventoDia.guardias}`;
      doc.fontSize(6).fillColor('black').text(texto, x + 2, y + 12 + idx * 20, { width: cellWidth - 4 });
    });

    columna++;
    if (columna > 6) { columna = 0; fila++; }
  }

  // Tabla detalle
  let yTabla = doc.y + 50;
  doc.fontSize(11).fillColor('#333').text('Guardias del mes:', 40, yTabla);
  yTabla += 20;

  // Header
  let cols = drawTableHeader(doc, yTabla);
  yTabla += 20;

  const limitePagina = 730;
  const xTabla = 40;
  const rowMin = 18;
  const padX = 4;
  const padY = 3;

  eventosMes.forEach((ev) => {
    const row = {
      fecha: ev.fecha || '',
      grupo: ev.grupo || '',
      evento: ev.evento || '',
      guardias: ev.guardias || '—'
    };

    // Alturas por celda (wrap)
    const hFecha = heightOfCell(doc, row.fecha,    cols[0].width - padX * 2);
    const hGrupo = heightOfCell(doc, row.grupo,    cols[1].width - padX * 2);
    const hEvento= heightOfCell(doc, row.evento,   cols[2].width - padX * 2);
    const hGuar  = heightOfCell(doc, row.guardias, cols[3].width - padX * 2);

    const rowHeight = Math.max(rowMin, padY * 2 + Math.max(hFecha, hGrupo, hEvento, hGuar));

    // Salto de página si no cabe
    if (yTabla + rowHeight > limitePagina) {
      doc.addPage();
      drawHeader(doc, { desde, hasta, grupoNombre });
      drawFooter(doc);
      yTabla = 130;
      cols = drawTableHeader(doc, yTabla);
      yTabla += 20;
    }

    // Caja fila
    doc.rect(xTabla, yTabla, 500, rowHeight).stroke();

    // Textos (pintamos con Helvetica 9pt)
    doc.font('Helvetica').fontSize(9).fillColor('black');
    doc.text(row.fecha,    cols[0].x, yTabla + padY, { width: cols[0].width - padX * 2 });
    doc.text(row.grupo,    cols[1].x, yTabla + padY, { width: cols[1].width - padX * 2 });
    doc.text(row.evento,   cols[2].x, yTabla + padY, { width: cols[2].width - padX * 2 });
    doc.text(row.guardias, cols[3].x, yTabla + padY, { width: cols[3].width - padX * 2 });

    yTabla += rowHeight;
  });
}

function generarPdfGuardias(res, { eventos, desde, hasta, grupoNombre }) {
  const doc = new PDFDocument({ margin: 30, size: 'A4' });
  res.setHeader('Content-disposition', 'attachment; filename="calendario_guardias.pdf"');
  res.setHeader('Content-type', 'application/pdf');
  doc.pipe(res);

  drawHeader(doc, { desde, hasta, grupoNombre });
  drawFooter(doc);
  doc.on('pageAdded', () => {
    drawHeader(doc, { desde, hasta, grupoNombre });
    drawFooter(doc);
  });

  // indexar por mes (YYYY-MM)
  const eventosPorMes = {};
  eventos.forEach(ev => {
    const f = dayjs(ev.fecha);
    const key = f.format('YYYY-MM');
    if (!eventosPorMes[key]) eventosPorMes[key] = [];
    eventosPorMes[key].push({
      dia: f.date(),
      evento: ev.evento,
      grupo: ev.grupo.replace(/\s*\(.*\)/, ''),
      guardias: [ev.guardia1, ev.guardia2].filter(Boolean).join(' y '),
      fecha: f.format('DD/MM/YYYY')
    });
  });

  const meses = Object.keys(eventosPorMes).sort();
  meses.forEach((mesKey, idx) => {
    const [year, month] = mesKey.split('-').map(Number);
    if (idx > 0) doc.addPage();
    renderMonthCalendar(doc, {
      year, month,
      eventosMes: eventosPorMes[mesKey],
      desde, hasta, grupoNombre
    });
  });

  doc.end();
}

module.exports = { generarPdfGuardias };
