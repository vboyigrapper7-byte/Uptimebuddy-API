exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMP;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE monitors DROP COLUMN IF EXISTS last_alert_at;
    `);
};
