const fs = require('fs');
const path = require('path');

/**
 * Ensures all necessary database tables exist.
 * Reads the schema.sql file and executes it.
 */
async function initializeDatabase(pool) {
    try {
        console.log('[DB Init] Verifying database schema...');
        
        const schemaPath = path.resolve(__dirname, 'schema.sql');
        if (!fs.existsSync(schemaPath)) {
            console.error('[DB Init] CRITICAL: schema.sql not found at', schemaPath);
            return;
        }

        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        
        // Execute the full schema.sql
        // Safe to run because it uses 'IF NOT EXISTS'
        await pool.query(schemaSql);
        
        console.log('[DB Init] Database schema verified/created successfully.');
    } catch (err) {
        console.error('[DB Init] CRITICAL ERROR during schema initialization:', err.message);
        // We don't throw here to allow the server to start, 
        // but routes will fail gracefully with the 500 error messages we added.
    }
}

module.exports = { initializeDatabase };
