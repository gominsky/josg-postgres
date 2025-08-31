// routes/layouts.js
const { Router } = require('express');
const pool = require('../database/db');
const router = Router();

// Cambia esto por cómo expongas el usuario en sesión:
function getUserId(req) {
  // ejemplos: req.session.user?.id  o req.user?.id
  return req.session?.user?.id ?? null;
}

// Obtener layout de un menú
router.get('/api/layout/:menu', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    // Sin usuario -> devolvemos vacío para usar localStorage
    if (!userId) return res.json({ order_ids: [], sizes: {}, colors: {} });

    const { rows: [row] } = await pool.query(
      'SELECT order_ids, sizes, colors FROM user_layouts WHERE user_id = $1 AND menu = $2',
      [userId, req.params.menu]
    );
    if (!row) return res.json({ order_ids: [], sizes: {}, colors: {} });
    res.json(row);
  } catch (e) { next(e); }
});

// Guardar layout de un menú
router.post('/api/layout/:menu', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok:false, msg:'No autenticado' });

    const { order_ids = [], sizes = {}, colors = {} } = req.body || {};
    await pool.query(`
      INSERT INTO user_layouts (user_id, menu, order_ids, sizes, colors)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id, menu)
      DO UPDATE SET order_ids = EXCLUDED.order_ids,
                    sizes     = EXCLUDED.sizes,
                    colors    = EXCLUDED.colors,
                    updated_at= NOW()
    `, [userId, req.params.menu, order_ids, sizes, colors]);

    res.json({ ok:true });
  } catch (e) { next(e); }
});

module.exports = router;
