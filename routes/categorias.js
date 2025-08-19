// routes/categorias.js
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

/* ========= Helpers ========= */
function parsePadreId(v){
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'null') return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ========= LISTA ========= */
// Lista con búsqueda opcional por nombre. Muestra nombre del padre si existe.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  const where = [];

  if (q) { params.push(`%${q}%`); where.push(`c.nombre ILIKE $${params.length}`); }

  try {
    const { rows } = await db.query(
      `
      SELECT
        c.id, c.nombre, c.padre_id,
        p.nombre AS padre_nombre
      FROM categorias_gasto c
      LEFT JOIN categorias_gasto p ON p.id = c.padre_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY lower(c.nombre) ASC
      `,
      params
    );

    res.render('categorias_lista', {
      title: 'Categorías de gasto',
      hero: false,
      categorias: rows,
      q
    });
  } catch (e) {
    console.error(e);
    res.render('categorias_lista', { title: 'Categorías de gasto', hero:false, categorias: [], q });
  }
});

/* ========= NUEVA ========= */
router.get('/nuevo', async (_req, res) => {
  try {
    const padres = await db.query(`SELECT id, nombre FROM categorias_gasto ORDER BY lower(nombre) ASC`);
    res.render('categorias_form', {
      title: 'Nueva categoría',
      hero: false,
      cat: null,
      padres: padres.rows,
      EDIT: false
    });
  } catch (e) {
    console.error(e);
    res.render('categorias_form', { title:'Nueva categoría', hero:false, cat:null, padres:[], EDIT:false });
  }
});

router.post('/nuevo', async (req, res) => {
  try {
    const nombre   = (req.body.nombre || '').trim();
    const padre_id = parsePadreId(req.body.padre_id);
    if (!nombre) return res.status(400).send('Falta el nombre');

    await db.query(
      `INSERT INTO categorias_gasto (nombre, padre_id) VALUES ($1,$2)`,
      [nombre, padre_id]
    );
    res.redirect('/categorias?ok=1');
  } catch (e) {
    console.error(e);
    res.redirect('/categororias/nuevo'); // no pasa nada si redirige mal; ajusta si quieres
  }
});

/* ========= EDITAR ========= */
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).send('Categoría no encontrada');

  try {
    const catQ = await db.query(
      `SELECT id, nombre, padre_id FROM categorias_gasto WHERE id=$1`, [id]
    );
    if (!catQ.rows.length) return res.status(404).send('Categoría no encontrada');

    // Posibles padres (excluye a sí misma)
    const padres = await db.query(
      `SELECT id, nombre FROM categorias_gasto WHERE id <> $1 ORDER BY lower(nombre) ASC`, [id]
    );

    res.render('categorias_form', {
      title: 'Editar categoría',
      hero: false,
      cat: catQ.rows[0],
      padres: padres.rows,
      EDIT: true
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error al cargar la categoría');
  }
});

router.post('/:id', async (req, res) => {
  try {
    const id       = parseInt(req.params.id, 10);
    const nombre   = (req.body.nombre || '').trim();
    let   padre_id = parsePadreId(req.body.padre_id);

    if (!Number.isInteger(id)) return res.status(404).send('Categoría no encontrada');
    if (!nombre) return res.status(400).send('Falta el nombre');
    if (padre_id === id) padre_id = null; // evita ser su propio padre

    await db.query(
      `UPDATE categorias_gasto SET nombre=$1, padre_id=$2 WHERE id=$3`,
      [nombre, padre_id, id]
    );
    res.redirect(`/categorias/${id}?ok=1`);
  } catch (e) {
    console.error(e);
    res.redirect(`/categorias/${req.params.id}`);
  }
});

/* ========= ELIMINAR ========= */
// Elimina físicamente. Quita el vínculo de hijas y libera facturas.
router.post('/:id/eliminar', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).send('Categoría no válida');

  try {
    await db.query('BEGIN');

    // 1) Desvincula hijas
    await db.query(`UPDATE categorias_gasto SET padre_id = NULL WHERE padre_id = $1`, [id]);

    // 2) Libera facturas que usen esta categoría (si la FK lo permite)
    await db.query(`UPDATE facturas_prov SET categoria_id = NULL WHERE categoria_id = $1`, [id]);

    // 3) Borra la categoría
    await db.query(`DELETE FROM categorias_gasto WHERE id = $1`, [id]);

    await db.query('COMMIT');
    res.redirect('/categorias?ok=1');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error(e);
    res.status(500).send('No se pudo eliminar la categoría (puede estar referenciada por otras tablas).');
  }
});

module.exports = router;
