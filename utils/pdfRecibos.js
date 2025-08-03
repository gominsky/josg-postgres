const path = require('path');

// --- Header ---
function drawHeader(doc, referencia = null) {
    const logoPath = path.join(__dirname, '..', 'public', 'imagenes', 'logoJosg.png');
    try {
      doc.image(logoPath, 40, 30, { width: 60 });
    } catch (e) {
      console.warn('⚠️ Logo no encontrado en', logoPath);
    }
  
    if (referencia) {
      doc.fontSize(10).font('Helvetica-Bold').text(`Ref: ${referencia}`, 460, 40, { align: 'right' });
    }
  }
  

// --- Footer ---
function drawFooter(doc) {
    const y = 660;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('gray').stroke();
    doc.fontSize(7).fillColor('gray').text(
      `\nAsociación Joven Orquesta de Granada\n` +
      `CIF: G-18651067 · www.josg.org · Tfno: 682445971\n` +
      `C/ Andrés Segovia 60, 18007 Granada\n` +
      `Sede de ensayos: Teatro Maestro Francisco Alonso, C/ Ribera del Beiro 34, 18012 Granada`,
      40, y
    );
  }
  
// --- Tabla de clave-valor ---
function drawKeyValueTable(doc, rows, { x, y, col1Width, col2Width, lineHeight, cellPadding }) {
  rows.forEach(([label, value], index) => {
    const yOffset = y + index * lineHeight;

    doc.rect(x, yOffset, col1Width, lineHeight).stroke();
    doc.font('Helvetica-Bold').fontSize(10).text(label, x + cellPadding, yOffset + cellPadding, {
      width: col1Width - 2 * cellPadding
    });

    doc.rect(x + col1Width, yOffset, col2Width, lineHeight).stroke();
    doc.font('Helvetica').fontSize(10).text(value, x + col1Width + cellPadding, yOffset + cellPadding, {
      width: col2Width - 2 * cellPadding
    });
  });

  doc.y = y + rows.length * lineHeight;
}

// --- Generador principal del recibo ---
function generarReciboPago(doc, pago, cuotas) {
    const margin = 40;
    const lineHeight = 20;
    const cellPadding = 5;
    const col1Width = 120;
    const col2Width = 350;
    const pageHeight = 792; // A4 altura
    const footerHeight = 80;
  
    drawHeader(doc, pago.referencia);
    // Ajusta la posición vertical manualmente para precisión
    doc.moveTo(0, 120); // (x, y)
    doc.fontSize(16).font('Helvetica-Bold')
       .text('RECIBO DE PAGO', 0, undefined, { align: 'center', width: doc.page.width })
       .moveDown(2);
    
  
    // --- Datos del alumno ---
    doc.fontSize(12).font('Helvetica-Bold').text('Datos del alumno', margin).moveDown(0.5);
    drawKeyValueTable(doc, [
      ['Nombre', `${pago.nombre_alumno} ${pago.apellidos}`],
      ['DNI', pago.dni || '—'],
      ['Email', pago.email || '—']
    ], { x: margin, y: doc.y, col1Width, col2Width, lineHeight, cellPadding });
    doc.moveDown(1.5);
  
    // --- Detalles del pago ---
    doc.fontSize(12).font('Helvetica-Bold').text('Detalles del pago', margin).moveDown(0.5);
    drawKeyValueTable(doc, [
      ['Fecha', new Date(pago.fecha_pago).toLocaleDateString('es-ES')],
      ['Medio de pago', pago.medio_pago],
      ['Referencia', pago.referencia || '—']
    ], { x: margin, y: doc.y, col1Width, col2Width, lineHeight, cellPadding });
    doc.moveDown(1.5);
  
    // --- Cuotas cubiertas ---
    doc.fontSize(12).font('Helvetica-Bold').text('Cuotas cubiertas', margin).moveDown(0.5);
    if (cuotas.length > 0) {
      cuotas.forEach((c, i) => {
        if (doc.y > pageHeight - footerHeight - 40) {
          drawFooter(doc); // Footer en la página actual antes de saltar
          doc.addPage();
          drawHeader(doc);
          doc.fontSize(12).font('Helvetica-Bold').text('Cuotas cubiertas (continuación)', margin).moveDown(0.5);
        }
  
        doc.font('Helvetica').fontSize(10).text(
          `${i + 1}. ${c.cuota_nombre} (${new Date(c.fecha_vencimiento).toLocaleDateString('es-ES')}) - ${Number(c.importe_aplicado).toFixed(2)} €`,
          { indent: 10 }
        );
      });
    } else {
      doc.font('Helvetica').fontSize(10).text('No se encontraron cuotas asociadas.', { indent: 10 });
    }
  
    doc.moveDown(2);
  
    // --- Total pagado ---
    if (doc.y > pageHeight - footerHeight - 60) {
      drawFooter(doc);
      doc.addPage();
      drawHeader(doc);
    }
  
    doc.moveTo(margin, doc.y).lineTo(555, doc.y).stroke().moveDown(0.5);
    const total = cuotas.reduce((acc, c) => acc + parseFloat(c.importe_aplicado || 0), 0);
    doc.fontSize(14).font('Helvetica-Bold').text(`Total pagado: ${total.toFixed(2)} €`, margin);
    doc.fontSize(10).fillColor('gray').text(`Referencia: ${pago.referencia || '—'}`, 460, doc.page.height - 100, { align: 'right' });  
    drawFooter(doc); // Footer final en la última página
}
  
module.exports = { generarReciboPago };

