/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Table to track agent releases
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_releases (
      id                 SERIAL PRIMARY KEY,
      version            VARCHAR(50) UNIQUE NOT NULL,
      is_stable          BOOLEAN NOT NULL DEFAULT true,
      rollout_percentage INTEGER NOT NULL DEFAULT 100,
      release_notes      TEXT,
      created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Table to track binary metadata per platform
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_binaries (
      id             SERIAL PRIMARY KEY,
      release_id     INTEGER NOT NULL REFERENCES agent_releases(id) ON DELETE CASCADE,
      platform       VARCHAR(50) NOT NULL,
      architecture   VARCHAR(50) NOT NULL,
      file_path      TEXT NOT NULL,
      sha256         VARCHAR(64) NOT NULL,
      download_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  pgm.sql(`
    ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS platform VARCHAR(50);
    ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS architecture VARCHAR(50);
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS agent_binaries_platform_architecture_index ON agent_binaries(platform, architecture);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS agent_binaries_release_id_index ON agent_binaries(release_id);`);

  // 3. Update agents table
  pgm.sql(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(20) NOT NULL DEFAULT 'node';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_version VARCHAR(50);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_ip VARCHAR(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_ip VARCHAR(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS hostname VARCHAR(255);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS os_type VARCHAR(50);
  `);

  // 4. Update agent_metrics table with hardware stats
  pgm.sql(`
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_total_mb INTEGER;
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_total_gb NUMERIC;
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_free_gb NUMERIC;
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS uptime_seconds BIGINT;
  `);
};

exports.down = (pgm) => {
  pgm.dropColumns('agents', ['agent_type', 'agent_version']);
  pgm.dropTable('agent_binaries');
  pgm.dropTable('agent_releases');
};
