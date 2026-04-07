/**
 * UptimeBuddy Admin Seeding Script
 * Creates the official system administrator account.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function seed() {
    const email    = 'admin@uptimebuddy.com';
    const password = 'Admin@123';
    
    console.log(`--- Seeding Admin: ${email} ---`);

    try {
        const hash = await bcrypt.hash(password, 12);
        
        // Use UPSERT (INSERT ... ON CONFLICT)
        await pool.query(`
            INSERT INTO users (email, password_hash, role, tier)
            VALUES ($1, $2, 'admin', 'pro')
            ON CONFLICT (email) 
            DO UPDATE SET 
                password_hash = EXCLUDED.password_hash,
                role = 'admin';
        `, [email, hash]);

        console.log('--- Admin Account Created/Updated Successfully ---');
    } catch (err) {
        console.error('--- Seeding Failed ---', err.message);
    } finally {
        await pool.end();
    }
}

seed();
