/**
 * Shared PostgreSQL connection pool.
 * Import this module everywhere instead of creating new Pool() instances.
 * This ensures the entire backend shares a single connection pool.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.error('[DB Pool] CRITICAL ERROR: DATABASE_URL environment variable is MISSING.');
    console.error('[DB Pool] Ensure you have added DATABASE_URL to your Render Environment settings.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                  // max connections in the pool
    idleTimeoutMillis: 30000, // close idle connections after 30s
    connectionTimeoutMillis: 5000, // throw if can't get connection in 5s
    ssl: !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1')
        ? { rejectUnauthorized: false } 
        : false
});

pool.on('error', (err) => {
    console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

module.exports = pool;
