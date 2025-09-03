const express = require('express');
const router = express.Router();
const db = require('../database/db');
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const puppeteer = require('puppeteer');
function getExportOpts(req){
  const allowed = new Set(['classic','orange','noir','cream','gradient']);

  const rawStyle = (req.query.style || '').toLowerCase().trim();
  const rawLook  = (req.query.look  || '').toLowerCase().trim(); // compat antiguo a/b/c
  let style = rawStyle ||
              (rawLook === 'a' ? 'classic'
               : rawLook === 'b' ? 'cream'
               : rawLook === 'c' ? 'gradient'
               : 'classic');
  if (!allowed.has(style)) style = 'classic';

  const compact = ['1','true','yes','on'].includes(String(req.query.compact||'').toLowerCase());
  const showHeader = ['1','true','yes','on'].includes(String(req.query.showHeader||'').toLowerCase());
  const brandName = req.query.brandName || '';
  const brandLogoUrl = req.query.brandLogoUrl || '';

  // Filtros (los mismos que en la lista)
  const estado = (req.query.estado === '1' || req.query.estado === '0') ? req.query.estado : '';
  const q = req.query.q || '';

  return { style, compact, showHeader, brandName, brandLogoUrl, estado, q };
}

// GET /proveedores — listado con filtros
router.get('/', async (req, res) => {
    const { estado = '', q = '' } = req.query;
    const where = [];
    const params = [];
    if (estado === '1' || estado === '0') {
      where.push(`activo = $${params.length + 1}`);
      params.push(estado === '1');
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(unaccent(nombre) ILIKE unaccent($${params.length})
                  OR cif ILIKE $${params.length}
                  OR email ILIKE $${params.length}
                  OR telefono ILIKE $${params.length}
                  OR unaccent(contacto) ILIKE unaccent($${params.length}))`);
    }
  
    const sql = `
      SELECT id, nombre, cif, email, telefono, contacto, activo
      FROM proveedores
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY nombre ASC
    `;
    const { rows } = await db.query(sql, params);
  
    res.render('proveedores_lista', {
      title: 'Proveedores',
      hero: false,
      proveedores: rows || [],
      estado,
      q
    });
  });
  
// NUEVO
router.get('/nuevo', (req, res) => {
  res.render('proveedores_form', {
    title: 'Nuevo proveedor',
    hero: false,
    proveedor: null
  });
});

// CREAR
router.post('/nuevo', async (req, res) => {
  const {
    nombre, cif, email, telefono, direccion,
    municipio, provincia, codigo_postal, iban, contacto, notas
  } = req.body;
  try {
    await db.query(
      `INSERT INTO proveedores
       (nombre, cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [nombre, cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas]
    );
    res.redirect('/proveedores');
  } catch (e) {
    console.error(e);
    res.render('proveedores_form', {
      title: 'Nuevo proveedor',
      hero: false,
      proveedor: req.body,
      error: 'No se pudo guardar. Revisa los datos.'
    });
  }
});

// EDITAR
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM proveedores WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.redirect('/proveedores');
    res.render('proveedores_form', {
      title: 'Editar proveedor',
      hero: false,
      proveedor: rows[0]
    });
  } catch (e) {
    console.error(e);
    res.redirect('/proveedores');
  }
});

// ACTUALIZAR
router.post('/:id', async (req, res) => {
  const {
    nombre, cif, email, telefono, direccion,
    municipio, provincia, codigo_postal, iban, contacto, notas, activo
  } = req.body;
  try {
    await db.query(
      `UPDATE proveedores SET
         nombre=$1, cif=$2, email=$3, telefono=$4, direccion=$5,
         municipio=$6, provincia=$7, codigo_postal=$8, iban=$9,
         contacto=$10, notas=$11, activo=$12
       WHERE id=$13`,
      [nombre, cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas, activo === 'on', req.params.id]
    );
    res.redirect('/proveedores');
  } catch (e) {
    console.error(e);
    res.render('proveedores_form', {
      title: 'Editar proveedor',
      hero: false,
      proveedor: { id: req.params.id, ...req.body },
      error: 'No se pudo actualizar.'
    });
  }
});

// (Opcional) DESACTIVAR como “eliminar suave”
router.post('/:id/eliminar', async (req, res) => {
  try {
    await db.query('UPDATE proveedores SET activo=false WHERE id=$1', [req.params.id]);
    res.redirect('/proveedores');
  } catch (e) {
    console.error(e);
    res.redirect('/proveedores');
  }
});

// Util: coger proveedores por ids (CSV) o todos con filtros sencillos
async function fetchProveedores({ ids, estado = '', q = '' }) {
  const where = [];
  const params = [];

  if (ids && ids.length) {
    where.push(`id = ANY($${params.length + 1})`);
    params.push(ids.map(Number).filter(Boolean));
  }
  if (estado === '1' || estado === '0') {
    where.push(`activo = $${params.length + 1}`);
    params.push(estado === '1');
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(unaccent(nombre) ILIKE unaccent($${params.length})
                 OR cif ILIKE $${params.length}
                 OR email ILIKE $${params.length}
                 OR telefono ILIKE $${params.length}
                 OR unaccent(COALESCE(contacto,'')) ILIKE unaccent($${params.length}))`);
  }

  const sql = `
    SELECT id, nombre, cif, email, telefono, contacto, activo
      FROM proveedores
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY nombre ASC
  `;
  const { rows } = await db.query(sql, params);
  return rows || [];
}

// Vista HTML “imprimible” que reutiliza el diseño de tarjetas
router.get('/export/view', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
  const { style, compact, showHeader, brandName, brandLogoUrl, estado, q } = getExportOpts(req);

  const proveedores = await fetchProveedores({ ids, estado, q });
  res.render('proveedores_export', {
    title: 'Tarjetas de Proveedores',
    proveedores,
    style,
    compact,
    showHeader,
    brandName,
    brandLogoUrl
  });
});


// PDF (una o varias por A4)
router.get('/export/pdf', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
  const { style, compact, showHeader, brandName, brandLogoUrl, estado, q } = getExportOpts(req);

  const proveedores = await fetchProveedores({ ids, estado, q });

  const html = await new Promise((resolve, reject) => {
    req.app.render('proveedores_export', {
      title: 'Tarjetas de Proveedores',
      proveedores, style, compact, showHeader, brandName, brandLogoUrl
    }, (err, out) => err ? reject(err) : resolve(out));
  });

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType('screen');           // asegúrate de aplicar estilos de pantalla
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.bizcard');          // espera a que pinten las tarjetas

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="proveedores_tarjetas.pdf"');
    res.send(pdf);
  } catch (e) {
    await browser.close();
    console.error(e);
    res.status(500).send('No se pudo generar el PDF');
  }
});


// PNG por tarjeta (ZIP)
router.get('/export/png', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
  const { style, compact, showHeader, brandName, brandLogoUrl, estado, q } = getExportOpts(req);

  const proveedores = await fetchProveedores({ ids, estado, q });
  const html = await new Promise((resolve, reject) => {
    req.app.render('proveedores_export', {
      title: 'Tarjetas de Proveedores',
      proveedores, style, compact, showHeader, brandName, brandLogoUrl
    }, (err, out) => err ? reject(err) : resolve(out));
  });

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-cards-'));
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaType('screen');
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.bizcard');

    const cards = await page.$$('.bizcard[data-id]');
    const files = [];
    for (const card of cards) {
      const id = await card.evaluate(el => el.getAttribute('data-id'));
      const name = await card.evaluate(el => el.getAttribute('data-name') || 'proveedor');
      const safe = (name || 'proveedor').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-');
      const out = path.join(tmpdir, `tarjeta-${safe}-${id}.png`);
      await card.screenshot({ path: out });
      files.push(out);
    }

    await browser.close();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="proveedores_tarjetas_png.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    files.forEach(f => archive.file(f, { name: path.basename(f) }));
    await archive.finalize();
  } catch (e) {
    await browser.close();
    console.error(e);
    res.status(500).send('No se pudieron generar las imágenes');
  }
});


// vCard (.vcf) combinado
router.get('/export/vcf', async (req, res) => {
  const ids = (req.query.ids || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  const proveedores = await fetchProveedores({ ids });

  let vcf = '';
  for (const p of proveedores) {
    const nombre = (p.nombre || '').replace(/\r?\n/g, ' ');
    const contacto = (p.contacto || '').replace(/\r?\n/g, ' ');
    vcf += [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${nombre}`,
      contacto ? `N:${contacto};;;;` : '',
      p.email ? `EMAIL;TYPE=work:${p.email}` : '',
      p.telefono ? `TEL;TYPE=work,voice:${p.telefono}` : '',
      p.cif ? `NOTE:CIF/NIF: ${p.cif}` : '',
      `CATEGORIES:Proveedor`,
      'END:VCARD',
      ''
    ].filter(Boolean).join('\r\n');
  }

  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="proveedores.vcf"');
  res.send(vcf);
});

module.exports = router;
