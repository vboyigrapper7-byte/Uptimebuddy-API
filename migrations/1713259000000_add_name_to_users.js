exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP COLUMN IF EXISTS name;
    `);
};
