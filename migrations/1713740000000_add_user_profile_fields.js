exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_slug VARCHAR(255) UNIQUE;
    
    -- Index for fast public status page lookups
    CREATE INDEX IF NOT EXISTS idx_users_status_slug ON users(status_slug);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_status_slug;
    ALTER TABLE users DROP COLUMN IF EXISTS status_slug;
    ALTER TABLE users DROP COLUMN IF EXISTS name;
  `);
};
