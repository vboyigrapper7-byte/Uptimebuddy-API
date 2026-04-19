const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function patch() {
    console.log('--- Starting Agent Metrics Database Patch ---');
    
    if (!process.env.DATABASE_URL) {
        console.error('ERROR: DATABASE_URL not found in .env');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1')
            ? { rejectUnauthorized: false }
            : false
    });

    try {
        console.log('Connecting to database...');
        
        const queries = [
            'ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_rx_mb NUMERIC(10,3);',
            'ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_tx_mb NUMERIC(10,3);',
            'ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS uptime_seconds BIGINT;',
            'ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS process_count INT;',
            "UPDATE agents SET status = 'pending' WHERE status = 'active' AND last_seen IS NULL;" // Cleanup any stuck agents
        ];

        for (const sql of queries) {
            console.log(`Executing: ${sql}`);
            await pool.query(sql);
        }

        console.log('\nSUCCESS: Database schema updated for advanced agent telemetry.');
        console.log('Your agents should now begin reporting data correctly within 30-60 seconds.');
    } catch (err) {
        console.error('\nPATCH FAILED:', err.message);
    } finally {
        await pool.end();
    }
}

patch();
