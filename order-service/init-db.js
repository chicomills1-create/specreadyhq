'use strict';
/* Applies src/schema.sql to DATABASE_URL. Run once per database. */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('schema applied; tables:', tables.rows.map((r) => r.table_name).join(', '));
  await pool.end();
})().catch((err) => { console.error('init-db failed:', err.message); process.exit(1); });
