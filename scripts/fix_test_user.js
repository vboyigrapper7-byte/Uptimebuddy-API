require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/uptimebuddy' });

async function fix() {
  try {
    const hash = await bcrypt.hash('password123', 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = 1', [hash]);
    console.log("Fixed user 1 password to password123. Hash:", hash);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
fix();
