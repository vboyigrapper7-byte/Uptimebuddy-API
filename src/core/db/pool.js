/**
 * Shared PostgreSQL connection pool.
 * Import this module everywhere instead of creating new Pool() instances.
 * This ensures the entire backend shares a single connection pool.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                  // max connections in the pool
    idleTimeoutMillis: 30000, // close idle connections after 30s
    connectionTimeoutMillis: 5000, // throw if can't get connection in 5s
});

pool.on('error', (err) => {
    console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

module.exports = pool;
