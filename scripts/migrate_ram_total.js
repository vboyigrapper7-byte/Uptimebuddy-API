/**
 * Migration: Add ram_total_mb column to agent_metrics
 * Safe to run multiple times (IF NOT EXISTS).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('[Migration] Adding ram_total_mb column to agent_metrics...');
        await client.query('ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_total_mb INT');
        console.log('[Migration] ✓ Done. ram_total_mb column is ready.');
    } catch (err) {
        console.error('[Migration] Error:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
