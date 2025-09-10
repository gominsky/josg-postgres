const { Router } = require('express');
const pool = require('../database/db');
const router = Router();

// Usa la misma clave que tu app: req.session.usuario
function getUserId(req) {
  return req.session?.usuario?.id ?? null;
}

function boom(res, status, msg, detail) {
  if (detail) console.error(`[layouts] ${status} ${msg}:`, detail);
  else console.error(`[layouts] ${status} ${msg}`);
  return res.status(status).json({ ok:false, msg, ...(detail ? { detail: String(detail) } : {}) });
}

// GET: devuelve lo guardado (o vacío)
router.get('/api/layout/:menu', async (req, res, next) => {
  console.log('[layouts][GET] hit menu=%s user=%s', req.params.menu, getUserId(req));
  const userId = getUserId(req);
  const menu = req.params.menu;
  console.log(`[layouts][GET] user=${userId} menu=${menu}`);

  if (!userId) return res.json({ order_ids: [], sizes: {}, colors: {}, positions: {} });

  try {
    const { rows: [row] } = await pool.query(
      'SELECT order_ids, sizes, colors, positions FROM user_layouts WHERE user_id=$1 AND menu=$2',
      [userId, menu]
    );
    if (!row) return res.json({ order_ids: [], sizes: {}, colors: {}, positions: {} });
    return res.json(row);
  } catch (e) {
    return boom(res, 500, 'DB select failed', e.message);
  }
});

// POST: upsert completo (incluye positions)
router.post('/api/layout/:menu', async (req, res, next) => {
  console.log('[layouts][POST] hit menu=%s user=%s body=%o', req.params.menu, getUserId(req), req.body);
 
  const userId = req.session?.user?.id ?? null;
  const menu = req.params.menu;
  console.log('[layouts][POST] user=%s menu=%s body=%o', userId, menu, req.body);
  if (!userId) return res.status(401).json({ ok:false, msg:'No autenticado' });

  let { order_ids = [], sizes = {}, colors = {}, positions = {} } = req.body || {};
  if (!Array.isArray(order_ids)) return res.status(400).json({ ok:false, msg:'order_ids debe ser array' });
  order_ids = order_ids.map(String);
  if (!sizes || typeof sizes !== 'object') sizes = {};
  if (!colors || typeof colors !== 'object') colors = {};
  if (!positions || typeof positions !== 'object') positions = {};

  try {
    // Verifica que el usuario existe (FK)
    const { rows: u } = await pool.query('SELECT 1 FROM usuarios WHERE id=$1', [userId]);
    if (!u.length) return res.status(400).json({ ok:false, msg:'user_id no existe en usuarios' });

    const { rows: saved } = await pool.query(`
      INSERT INTO user_layouts (user_id, menu, order_ids, sizes, colors, positions)
      VALUES ($1, $2, $3::text[], $4::jsonb, $5::jsonb, $6::jsonb)
      ON CONFLICT (user_id, menu)
      DO UPDATE SET
        order_ids = EXCLUDED.order_ids,
        sizes     = EXCLUDED.sizes,
        colors    = EXCLUDED.colors,
        positions = EXCLUDED.positions,
        updated_at= NOW()
      RETURNING id, user_id, menu, updated_at
    `, [userId, menu, order_ids, sizes, colors, positions]);

    console.log('[layouts] UPSERT OK →', saved[0]);
    res.json({ ok:true, saved: saved[0] });
  } catch (e) {
    console.error('[layouts] DB upsert failed:', e);
    res.status(500).json({ ok:false, msg:'DB upsert failed', detail:String(e) });
  }
});

module.exports = router;
