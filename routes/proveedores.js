const express = require('express');
const router = express.Router();
const db = require('../database/db');

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
                  OR nif_cif ILIKE $${params.length}
                  OR email ILIKE $${params.length}
                  OR telefono ILIKE $${params.length})`);
    }
  
    const sql = `
      SELECT id, nombre, cif, email, telefono, activo
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
    nombre, nif_cif, email, telefono, direccion,
    municipio, provincia, codigo_postal, iban, contacto, notas
  } = req.body;
  try {
    await db.query(
      `INSERT INTO proveedores
       (nombre, nif_cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [nombre, nif_cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas]
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
    nombre, nif_cif, email, telefono, direccion,
    municipio, provincia, codigo_postal, iban, contacto, notas, activo
  } = req.body;
  try {
    await db.query(
      `UPDATE proveedores SET
         nombre=$1, nif_cif=$2, email=$3, telefono=$4, direccion=$5,
         municipio=$6, provincia=$7, codigo_postal=$8, iban=$9,
         contacto=$10, notas=$11, activo=$12
       WHERE id=$13`,
      [nombre, nif_cif, email, telefono, direccion, municipio, provincia, codigo_postal, iban, contacto, notas, activo === 'on', req.params.id]
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

module.exports = router;
