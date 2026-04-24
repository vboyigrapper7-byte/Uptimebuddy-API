exports.up = (pgm) => {
  pgm.sql(`
    -- Add logging columns to monitor_metrics for professional dashboard
    ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS status_code INT;
    ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE monitor_metrics DROP COLUMN IF EXISTS error_message;
    ALTER TABLE monitor_metrics DROP COLUMN IF EXISTS status_code;
  `);
};
