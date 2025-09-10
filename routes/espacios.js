const express = require('express');
const router = express.Router();
const db = require('../database/db');

/*
  Esquema objetivo (corregido):
  -----------------------------
  CREATE TABLE IF NOT EXISTS espacios (
    id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre                  TEXT NOT NULL,
    direccion               TEXT NOT NULL,
    ubicacion               TEXT,
    telefono                TEXT,
    email                   TEXT,
    sitio_web               TEXT,
    propietario             TEXT NOT NULL,
    tipo_espacio            TEXT
      CHECK (tipo_espacio IN ('Auditorio','Teatro','Aire libre')),
    aforo                   INTEGER,
    recursos_disponibles    TEXT,
    observaciones           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
*/

const COLS = [
  'nombre', 'direccion', 'ubicacion',
  'telefono', 'email', 'sitio_web',
  'propietario', 'tipo_espacio',
  'aforo', 'recursos_disponibles', 'observaciones'
];

// util: mapea req.body a columnas válidas del esquema
function pickCols(body){
  const out = {};
  for (const c of COLS){
    if (Object.prototype.hasOwnProperty.call(body, c)) {
      const v = body[c];
      out[c] = (v === '' || v == null) ? null : v;
    }
  }
  // numéricos
  if (out.aforo !== undefined) {
    if (out.aforo === null) {
      // deja null
    } else {
      const n = Number(out.aforo);
      out.aforo = Number.isFinite(n) ? n : null;
    }
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
        direccion ILIKE $1 OR
        ubicacion ILIKE $1 OR
        telefono ILIKE $1 OR
        email ILIKE $1 OR
        sitio_web ILIKE $1 OR
        propietario ILIKE $1 OR
        tipo_espacio ILIKE $1 OR
        recursos_disponibles ILIKE $1 OR
        observaciones ILIKE $1
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
    return res.status(400).send('El nombre es obligatorio');
  }
  if (!data.direccion || !data.direccion.trim()) {
    return res.status(400).send('La dirección es obligatoria');
  }
  if (!data.propietario || !data.propietario.trim()) {
    return res.status(400).send('El propietario es obligatorio');
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
