exports.up = (pgm) => {
  pgm.sql(`
    -- 1. User Billing & Plan Hardening
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expiry TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255);
    
    -- 2. Escalation State Management
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS escalation_state JSONB DEFAULT '{"step": 0, "last_trigger": null}'::jsonb;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'medium';
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS assertion_config JSONB DEFAULT '{}'::jsonb;

    -- 3. Teams & RBAC Infrastructure
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id INT REFERENCES teams(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member', -- owner, admin, member, viewer
      PRIMARY KEY (team_id, user_id)
    );

    -- Add team_id to monitors for shared ownership
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE SET NULL;

    -- 4. Audit Logging
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      team_id INT REFERENCES teams(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. Status Page Infrastructure (v2)
    CREATE TABLE IF NOT EXISTS status_pages (
      id SERIAL PRIMARY KEY,
      team_id INT REFERENCES teams(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_monitors_team_id ON monitors(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_team_id ON audit_logs(team_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS status_pages CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS team_members CASCADE;
    DROP TABLE IF EXISTS teams CASCADE;
    ALTER TABLE monitors DROP COLUMN IF EXISTS team_id;
    ALTER TABLE monitors DROP COLUMN IF EXISTS assertion_config;
    ALTER TABLE monitors DROP COLUMN IF EXISTS priority;
    ALTER TABLE monitors DROP COLUMN IF EXISTS escalation_state;
    ALTER TABLE users DROP COLUMN IF EXISTS subscription_id;
    ALTER TABLE users DROP COLUMN IF EXISTS plan_expiry;
  `);
};
