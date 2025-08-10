const path = require('path');

const logoPath = path.join(__dirname, '..', 'public', 'imagenes', 'logoJosg.png');

function drawHeader(doc, referencia = null) {
  // Logo (si no existe, no rompe)
  try { doc.image(logoPath, 40, 30, { width: 60 }); } catch (_) {}

  // Ref a la derecha
  if (referencia) {
    doc.fontSize(10).font('Helvetica-Bold').text(`Ref: ${referencia}`, 460, 40, { align: 'right' });
  }
}

function drawFooter(doc, pageNum) {
    const innerW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  
    const FOOTER_BLOCK_H = 70;
    const SEPARATOR_GAP  = 8;
    const NUM_GAP        = 10;
  
    const yTopLine  = doc.page.height - doc.page.margins.bottom - FOOTER_BLOCK_H - SEPARATOR_GAP - NUM_GAP;
    const yText     = yTopLine + SEPARATOR_GAP;
    const yPageNum  = doc.page.height - doc.page.margins.bottom - NUM_GAP;
  
    doc.save();
    doc.strokeColor('gray')
       .moveTo(doc.page.margins.left, yTopLine)
       .lineTo(doc.page.width - doc.page.margins.right, yTopLine)
       .stroke();
  
    doc.fontSize(7).fillColor('gray').text(
  `Asociación Joven Orquesta de Granada
  CIF: G-18651067 · www.josg.org · Tfno: 682445971
  C/ Andrés Segovia 60, 18007 Granada
  Sede de ensayos: Teatro Maestro Francisco Alonso, C/ Ribera del Beiro 34, 18012 Granada`,
      doc.page.margins.left, yText,
      { width: innerW, align: 'left', lineBreak: false }
    );
  
    // ⬇️ aquí usamos el contador propio
    doc.fontSize(8).fillColor('gray').text(
      `Página ${pageNum}`,
      doc.page.margins.left, yPageNum,
      { width: innerW, align: 'center', lineBreak: false }
    );
    doc.restore();
}
module.exports = { drawHeader, drawFooter };