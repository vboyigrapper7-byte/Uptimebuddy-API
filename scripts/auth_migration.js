require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function migrate() {
    console.log('--- Starting Auth Migration ---');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding columns to users table...');
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'customer',
            ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(255);
        `);

        console.log('Creating refresh_tokens table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id          SERIAL PRIMARY KEY,
                user_id     INT          REFERENCES users(id) ON DELETE CASCADE,
                token_hash  VARCHAR(255) NOT NULL,
                expires_at  TIMESTAMP    NOT NULL,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
        `);

        await client.query('COMMIT');
        console.log('--- Migration Successful ---');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('--- Migration Failed ---', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
