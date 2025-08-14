// db.js — único para local y Render
const { Pool, types } = require('pg');

// NUMERIC (OID 1700) -> float (evita strings en precios, etc.)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));

const isRender = !!process.env.DATABASE_URL;

const pool = new Pool(
  isRender
    ? {
        connectionString: process.env.DATABASE_URL,
        // Render necesita SSL; si lo desactivas, exporta PGSSLMODE=disable
        ssl:
          process.env.PGSSLMODE === 'disable'
            ? false
            : { rejectUnauthorized: false },
      }
    : {
        user: process.env.PGUSER || 'appuser',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'appdb',
        password: process.env.PGPASSWORD || 'apppass',
        port: Number(process.env.PGPORT) || 5432,
      }
);

// Opcional: fija zona horaria por conexión (útil para evitar desfases)
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Europe/Madrid'").catch(() => {});
});

// (Opcional) log básico de errores de conexión
pool.on('error', (err) => {
  console.error('❌ Error en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
