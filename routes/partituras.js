// routes/partituras.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database/db');

const router = express.Router();

// ====== Multer: subida a /public/partituras ======
const uploadDir = path.join(__dirname, '..', 'public', 'partituras');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination(_req, _file, cb) { cb(null, uploadDir); },
  filename(_req, file, cb) {
    const base = path.parse(file.originalname).name.replace(/[^\w\-]+/g, '_');
    const ext  = path.extname(file.originalname).toLowerCase();
    cb(null, `${base}-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ===== Helpers =====
function toBool(v){ return String(v) === '1' || v === true; }
function toIntOrNull(v){ const n = Number(v); return Number.isInteger(n) ? n : null; }
function parseTags(s){
  if (!s) return null;
  const parts = String(s).split(',').map(x => x.trim()).filter(Boolean);
  return parts.length ? parts : null;
}
function normIds(val){
  if (val == null) return [];
  if (Array.isArray(val)) return val.map(Number).filter(Number.isInteger);
  return [Number(val)].filter(Number.isInteger);
}

// ====== LISTA / VISTA ======
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();

  try {
    const { rows: grupos }       = await db.query('SELECT id, nombre FROM grupos ORDER BY nombre');
    const { rows: instrumentos } = await db.query('SELECT id, nombre FROM instrumentos ORDER BY nombre');
    const params = [];
    let sql = `
      SELECT p.*, g.nombre AS grupo_nombre
      FROM partituras p
      LEFT JOIN grupos g ON g.id = p.grupo_id
    `;
    if (q) {
      sql += ` WHERE lower(p.titulo) LIKE $1 OR lower(p.autor) LIKE $1`;
      params.push(`%${q.toLowerCase()}%`);
    }
    sql += ` ORDER BY p.updated_at DESC`;
    const { rows: partituras } = await db.query(sql, params);

    res.render('partituras_lista', {
      title: 'Partituras',
      q,
      partituras,
      grupos,
      instrumentos
    });
  } catch (err) {
    console.error('[partituras] GET / error:', err);
    res.status(500).send('Error al cargar partituras');
  }
});

// ====== CREAR ======
router.post('/', upload.single('archivo_partitura'), async (req, res) => {
  // helpers locales
  const normalizeUrl = (u) => {
    let s = String(u || '').trim();
    if (!s) return null;
    if (!/^[a-zA-Z][\w+.-]*:\/\//.test(s)) s = 'https://' + s;
    try { new URL(s); return s; } catch { return null; }
  };
  const toIntOrNull = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };
  const toBool = (v) => !(v === 'false' || v === false || v === 0 || v === '0');

  const {
    titulo, autor, arreglista, grupo_id,
    activo, duracion, genero,
    enlace_partitura: enlace_input,
    enlace_audio, descripcion, tags
  } = req.body;

  // 1) Resolver enlace_partitura (archivo tiene prioridad). OBLIGATORIO.
  // ⚠️ Usa la ruta estática correcta para servir archivos (normalmente /uploads/partituras/)
  let enlace_partitura = null;
  if (req.file) {
    enlace_partitura = '/partituras/' + req.file.filename; // <-- ajusta si tu static es otro
  } else {
    enlace_partitura = normalizeUrl(enlace_input);
  }

  // 2) Validaciones mínimas
  const tituloNorm  = (titulo || '').trim();
  const grupoIdNorm = toIntOrNull(grupo_id);

  if (!tituloNorm || !grupoIdNorm || !enlace_partitura) {
    return res
      .status(400)
      .send('Título, grupo y enlace de partitura son obligatorios (sube un archivo o indica una URL válida).');
  }

  // 3) Resto de campos
  const params = [
    tituloNorm,
    (autor || '').trim() || null,
    (arreglista || '').trim() || null,
    grupoIdNorm,
    toBool(activo),
    (duracion || '').trim() || null,
    (genero || '').trim() || null,
    enlace_partitura,                               // <-- nunca null aquí
    normalizeUrl(enlace_audio),                     // opcional
    (descripcion || '').trim() || null,
    parseTags?.(tags) || null
  ];

  const sql = `
    INSERT INTO partituras
      (titulo, autor, arreglista, grupo_id, activo, duracion, genero,
       enlace_partitura, enlace_audio, descripcion, tags)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id
  `;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(sql, params);
    const newId = rows[0].id;

    // N-N instrumentos (si procede)
    const instrumentosIds = (typeof normIds === 'function') ? normIds(req.body.instrumentos) : [];
    if (instrumentosIds.length) {
      const values = instrumentosIds.map((iid, i) => `($1, $${i+2})`).join(', ');
      await client.query(
        `INSERT INTO partitura_instrumento (partitura_id, instrumento_id)
         VALUES ${values} ON CONFLICT DO NOTHING`,
        [newId, ...instrumentosIds]
      );
    }

    await client.query('COMMIT');
    return res.redirect('/partituras');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[partituras] POST / error:', err);
    if (err.code === '23502') {
      // por si alguna mutación rara volviera a generar NULL
      return res.status(400).send('El enlace de la partitura es obligatorio y debe ser válido.');
    }
    res.status(500).send('Error guardando partitura');
  } finally {
    client.release();
  }
});


// ====== EDITAR ======
router.post('/:id', upload.single('archivo_partitura'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

  const {
    titulo, autor, arreglista, grupo_id,
    activo, duracion, genero,
    enlace_partitura: enlace_input,
    enlace_audio, descripcion, tags
  } = req.body;

  let enlace_partitura = (enlace_input || '').trim() || null;
  if (req.file) enlace_partitura = '/partituras/' + req.file.filename;

  const tagsArr = parseTags(tags);
  const instrumentosIds = normIds(req.body.instrumentos);

  const sql = `
    UPDATE partituras SET
      titulo = $1, autor = $2, arreglista = $3, grupo_id = $4, activo = $5,
      duracion = $6, genero = $7, enlace_partitura = $8, enlace_audio = $9,
      descripcion = $10, tags = $11, updated_at = NOW()
    WHERE id = $12
  `;
  const params = [
    titulo?.trim(),
    autor?.trim() || null,
    arreglista?.trim() || null,
    toIntOrNull(grupo_id),
    toBool(activo),
    duracion?.trim() || null,
    genero?.trim() || null,
    enlace_partitura,
    (enlace_audio || '').trim() || null,
    (descripcion || '').trim() || null,
    tagsArr,
    id
  ];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(sql, params);

    // reset instrumentos y volver a insertar
    await client.query('DELETE FROM partitura_instrumento WHERE partitura_id = $1', [id]);
    if (instrumentosIds.length) {
      const values = instrumentosIds.map((iid, i) => `($1, $${i+2})`).join(', ');
      await client.query(
        `INSERT INTO partitura_instrumento (partitura_id, instrumento_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [id, ...instrumentosIds]
      );
    }

    await client.query('COMMIT');
    return res.redirect('/partituras');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[partituras] POST /:id error:', err);
    res.status(500).send('Error actualizando partitura');
  } finally {
    client.release();
  }
});

// ====== LEER UNA (para modal edición) ======
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

  try {
    const { rows } = await db.query(
      `SELECT p.*, g.nombre AS grupo_nombre
         FROM partituras p
         LEFT JOIN grupos g ON g.id = p.grupo_id
        WHERE p.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('No encontrada');

    const { rows: inst } = await db.query(
      'SELECT instrumento_id FROM partitura_instrumento WHERE partitura_id = $1 ORDER BY instrumento_id',
      [id]
    );

    const p = rows[0];
    p.instrumentos = inst.map(r => r.instrumento_id); // array de ids para <select multiple>
    res.json(p);
  } catch (err) {
    console.error('[partituras] GET /:id error:', err);
    res.status(500).send('Error al cargar la partitura');
  }
});

// ====== ACTUALIZAR con PUT (multipart) ======
router.put('/:id', upload.single('archivo_partitura'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

    // mismas utilidades que en POST
  const normalizeUrl = (u) => {
    let s = String(u || '').trim();
    if (!s) return null;
    if (!/^[a-zA-Z][\w+.-]*:\/\//.test(s)) s = 'https://' + s;
    try { new URL(s); return s; } catch { return null; }
  };

  const {
    titulo, autor, arreglista, grupo_id,
    activo, duracion, genero,
    enlace_partitura: enlace_input,
    enlace_audio, descripcion, tags
  } = req.body;

  let enlace_partitura = null;
  if (req.file) {
    enlace_partitura = '/partituras/' + req.file.filename;   // subido a /public/partituras
  } else {
    enlace_partitura = normalizeUrl(enlace_input);            // externa (https://…)
  }

  const tagsArr = parseTags(tags);
  const instrumentosIds = normIds(req.body.instrumentos || req.body['instrumentos[]']);

  const sql = `
    UPDATE partituras SET
      titulo = $1, autor = $2, arreglista = $3, grupo_id = $4, activo = $5,
      duracion = $6, genero = $7, enlace_partitura = $8, enlace_audio = $9,
      descripcion = $10, tags = $11, updated_at = NOW()
    WHERE id = $12
  `;
  const params = [
    titulo?.trim(),
    autor?.trim() || null,
    arreglista?.trim() || null,
    toIntOrNull(grupo_id),
    toBool(activo),
    duracion?.trim() || null,
    genero?.trim() || null,
    enlace_partitura,
    (enlace_audio || '').trim() || null,
    (descripcion || '').trim() || null,
    tagsArr,
    id
  ];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(sql, params);
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('No encontrada');
    }

    await client.query('DELETE FROM partitura_instrumento WHERE partitura_id = $1', [id]);
    if (instrumentosIds.length) {
      const values = instrumentosIds.map((iid, i) => `($1, $${i+2})`).join(', ');
      await client.query(
        `INSERT INTO partitura_instrumento (partitura_id, instrumento_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [id, ...instrumentosIds]
      );
    }

    await client.query('COMMIT');
    res.status(200).send('OK');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[partituras] PUT /:id error:', err);
    res.status(500).send('Error actualizando partitura');
  } finally {
    client.release();
  }
});

// ====== ELIMINAR ======
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('ID inválido');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM partitura_instrumento WHERE partitura_id = $1', [id]);
    const r = await client.query('DELETE FROM partituras WHERE id = $1', [id]);
    await client.query('COMMIT');
    if (r.rowCount === 0) return res.status(404).send('No encontrada');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[partituras] DELETE /:id error:', err);
    res.status(500).send('Error eliminando');
  } finally {
    client.release();
  }
});

module.exports = router;
