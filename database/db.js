// db.js (nuevo para PostgreSQL)
const { Pool } = require('pg');

const pool = new Pool({
  user: 'appuser',
  host: 'localhost',
  database: 'appdb',
  password: 'apppass',
  port: 5432,
});

module.exports = pool;
