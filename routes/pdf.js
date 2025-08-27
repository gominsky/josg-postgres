const { Router } = require('express');
const { PassThrough } = require('stream');
const PDFDocument = require('pdfkit');
const { uploadPdfStream } = require('../lib/s3');

const router = Router();

router.post('/api/informes/:id/pdf-url', async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1) Preparar stream hacia S3
    const key = `informes/${id}-${Date.now()}.pdf`;
    const pass = new PassThrough();
    const urlPromise = uploadPdfStream(key, pass, { inlineName: `informe-${id}.pdf` });

    // 2) Generar PDF y pipe al PassThrough
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(pass);

    // --- TU CONTENIDO PDF ---
    doc.fontSize(18).text(`Informe ${id}`);
    doc.moveDown().fontSize(12).text(`Generado: ${new Date().toLocaleString('es-ES')}`);
    // -------------------------
    doc.end();

    // 3) Esperar subida y responder con la URL
    const url = await urlPromise;
    res.json({ ok: true, url, key });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
