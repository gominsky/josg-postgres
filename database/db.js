// db.js (nuevo para PostgreSQL)

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // necesario en Render
  }
});

module.exports = pool;
