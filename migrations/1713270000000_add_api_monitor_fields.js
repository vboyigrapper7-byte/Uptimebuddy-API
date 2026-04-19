exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        -- Add REST/API fields to monitors table
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'GET';
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS headers JSONB;
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS body TEXT;
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS threshold_ms INT DEFAULT 0;
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS region VARCHAR(50) DEFAULT 'Global';
        
        -- Add public status slug to users
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status_slug VARCHAR(255) UNIQUE;
        
        -- Index for fast public status page lookups
        CREATE INDEX IF NOT EXISTS idx_users_status_slug ON users(status_slug);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS idx_users_status_slug;
        ALTER TABLE users DROP COLUMN IF EXISTS status_slug;
        ALTER TABLE monitors DROP COLUMN IF EXISTS method;
        ALTER TABLE monitors DROP COLUMN IF EXISTS headers;
        ALTER TABLE monitors DROP COLUMN IF EXISTS body;
        ALTER TABLE monitors DROP COLUMN IF EXISTS threshold_ms;
        ALTER TABLE monitors DROP COLUMN IF EXISTS region;
    `);
};
