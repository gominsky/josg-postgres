// db.js (nuevo para PostgreSQL)
const { Pool, types } = require('pg');

// Forzar que los campos NUMERIC (OID 1700) se devuelvan como float
types.setTypeParser(1700, val => parseFloat(val));

const pool = new Pool({
  user: 'appuser',
  host: 'localhost',
  database: 'appdb',
  password: 'apppass',
  port: 5432,
});

module.exports = pool;
