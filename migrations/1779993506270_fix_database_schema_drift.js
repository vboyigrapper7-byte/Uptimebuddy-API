exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Add missing columns to teams table
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    -- 2. Add missing columns to audit_logs table
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS admin_id INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50);
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id VARCHAR(100);
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS old_value JSONB;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS new_value JSONB;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams DROP COLUMN IF EXISTS owner_id;
    ALTER TABLE teams DROP COLUMN IF EXISTS created_at;

    ALTER TABLE audit_logs DROP COLUMN IF EXISTS admin_id;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS entity_type;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS entity_id;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS old_value;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS new_value;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS ip_address;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS user_agent;
  `);
};
