exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status_slug VARCHAR(100) UNIQUE;
        CREATE INDEX IF NOT EXISTS idx_users_status_slug ON users(status_slug);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS idx_users_status_slug;
        ALTER TABLE users DROP COLUMN IF EXISTS status_slug;
    `);
};
