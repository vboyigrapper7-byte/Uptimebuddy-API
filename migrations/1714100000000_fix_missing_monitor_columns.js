exports.up = (pgm) => {
  pgm.sql(`
    -- Add missing API-focused columns to monitors table
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS timeout_ms INT DEFAULT 10000;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS max_retries INT DEFAULT 3;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS expected_status VARCHAR(50) DEFAULT '200-399';
    
    -- Ensure all existing monitors have these defaults
    UPDATE monitors SET timeout_ms = 10000 WHERE timeout_ms IS NULL;
    UPDATE monitors SET max_retries = 3 WHERE max_retries IS NULL;
    UPDATE monitors SET expected_status = '200-399' WHERE expected_status IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE monitors DROP COLUMN IF EXISTS expected_status;
    ALTER TABLE monitors DROP COLUMN IF EXISTS max_retries;
    ALTER TABLE monitors DROP COLUMN IF EXISTS timeout_ms;
  `);
};
