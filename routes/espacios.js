const express = require('express');
const router = express.Router();
const db = require('../database/db');

/*
  SUGERENCIA DE ESQUEMA (ajústalo a tu BBDD):
  -------------------------------------------
  CREATE TABLE IF NOT EXISTS espacios (
    id              SERIAL PRIMARY KEY,
    nombre          TEXT NOT NULL,
    codigo          TEXT,
    abreviatura     TEXT,
    tipo            TEXT,
    edificio        TEXT,
    planta          TEXT,
    ubicacion       TEXT,
    capacidad       INTEGER,
    aforo           INTEGER,
    superficie_m2   NUMERIC,
    recursos        TEXT,        -- lista simple o JSON en texto
    color           TEXT,
    calendar_id     TEXT,
    activo          BOOLEAN DEFAULT TRUE,
    descripcion     TEXT,
    notas           TEXT,
    created_at      TIMESTAMP DEFAULT now(),
    updated_at      TIMESTAMP DEFAULT now()
  );
*/

const COLS = [
  'nombre','codigo','abreviatura','tipo','edificio','planta','ubicacion',
  'capacidad','aforo','superficie_m2','recursos','color','calendar_id',
  'activo','descripcion','notas'
];

// util: mapea body a columnas válidas
function pickCols(body){
  const out = {};
  for (const c of COLS){
    if (Object.prototype.hasOwnProperty.call(body, c)) out[c] = body[c];
  }
  // normaliza booleano de checkbox
  if (Object.prototype.hasOwnProperty.call(body, 'activo')) {
    out.activo = (body.activo === 'on' || body.activo === true || body.activo === 'true');
  }
  // números
  for (const k of ['capacidad','aforo','superficie_m2']){
    if (out[k] === '' || out[k] == null) { out[k] = null; continue; }
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) ? n : null;
  }
  return out;
}

// LISTA + búsqueda
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const ORDER = 'ORDER BY lower(nombre) ASC, id ASC';
  let sql, params;
  if (q) {
    sql = `
      SELECT * FROM espacios
      WHERE
        nombre ILIKE $1 OR
        tipo ILIKE $1 OR
        edificio ILIKE $1 OR
        ubicacion ILIKE $1 OR
        descripcion ILIKE $1 OR
        notas ILIKE $1
      ${ORDER}`;
    params = [`%${q}%`];
  } else {
    sql = `SELECT * FROM espacios ${ORDER}`;
    params = [];
  }

  try {
    const { rows } = await db.query(sql, params);
    res.render('espacios_lista', { espacios: rows, q, hero:false });
  } catch (err) {
    console.error('Error listando espacios:', err);
    res.status(500).send('Error listando espacios');
  }
});

// NUEVO
router.get('/nuevo', (req, res) => {
  res.render('espacios_ficha', { espacio: null, hero:false });
});

// CREAR
router.post('/', async (req, res) => {
  const data = pickCols(req.body);
  if (!data.nombre || !data.nombre.trim()) {
    return res.status(400).send('Nombre es obligatorio');
  }

  const cols = Object.keys(data);
  const vals = Object.values(data);
  const marks = cols.map((_,i)=>`$${i+1}`).join(', ');

  const sql = `
    INSERT INTO espacios (${cols.join(', ')})
    VALUES (${marks})
    RETURNING id;
  `;

  try {
    const { rows } = await db.query(sql, vals);
    const id = rows[0]?.id;
    res.redirect(id ? `/espacios/editar/${id}` : '/espacios');
  } catch (err) {
    console.error('Error creando espacio:', err);
    res.status(500).send('Error creando espacio');
  }
});

// EDITAR (form)
router.get('/editar/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');
  try {
    const { rows } = await db.query('SELECT * FROM espacios WHERE id=$1', [id]);
    const espacio = rows[0];
    if (!espacio) return res.status(404).send('Espacio no encontrado');
    res.render('espacios_ficha', { espacio, hero:false });
  } catch (err) {
    console.error('Error cargando espacio:', err);
    res.status(500).send('Error cargando espacio');
  }
});

// ACTUALIZAR
router.post('/editar/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

  const data = pickCols(req.body);
  if (!Object.keys(data).length) return res.redirect('/espacios');

  const sets = Object.keys(data).map((c,i)=> `${c} = $${i+1}`);
  const vals = Object.values(data);

  const sql = `
    UPDATE espacios
       SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${vals.length+1}
  `;

  try {
    await db.query(sql, [...vals, id]);
    res.redirect('/espacios');
  } catch (err) {
    console.error('Error actualizando espacio:', err);
    res.status(500).send('Error actualizando espacio');
  }
});

// ELIMINAR (POST desde formulario)
router.post('/eliminar/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');
  try {
    await db.query('DELETE FROM espacios WHERE id=$1', [id]);
    res.redirect('/espacios');
  } catch (err) {
    console.error('Error eliminando espacio:', err);
    res.status(500).send('Error eliminando espacio');
  }
});

// REST DELETE (opcional)
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok:false, error:'ID inválido' });
  try {
    await db.query('DELETE FROM espacios WHERE id=$1', [id]);
    res.json({ ok:true });
  } catch (err) {
    console.error('Error eliminando espacio:', err);
    res.status(500).json({ ok:false, error:'Error eliminando espacio' });
  }
});

module.exports = router;
