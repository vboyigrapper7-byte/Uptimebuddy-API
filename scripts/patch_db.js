const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

async function run() {
    console.log('--- DB Patch Started ---');
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL not found in .env');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
    });

    try {
        console.log('Applying Monitor API fields...');
        await pool.query(`
            ALTER TABLE monitors ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'GET';
            ALTER TABLE monitors ADD COLUMN IF NOT EXISTS headers JSONB;
            ALTER TABLE monitors ADD COLUMN IF NOT EXISTS body TEXT;
            ALTER TABLE monitors ADD COLUMN IF NOT EXISTS threshold_ms INT DEFAULT 0;
            ALTER TABLE monitors ADD COLUMN IF NOT EXISTS region VARCHAR(50) DEFAULT 'Global';
            
            ALTER TABLE users ADD COLUMN IF NOT EXISTS status_slug VARCHAR(255) UNIQUE;
        `);
        console.log('Applying Indexes...');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_status_slug ON users(status_slug)');
        
        console.log('--- DB Patch Complete Successfully ---');
    } catch (err) {
        console.error('Error applying patch:', err);
    } finally {
        await pool.end();
    }
}

run();
