exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'email';
        
        -- Update existing users to 'email' if provider is null
        UPDATE users SET provider = 'email' WHERE provider IS NULL;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP COLUMN IF EXISTS provider;
    `);
};
