exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Create Monitor Stats table for precomputed metrics
    CREATE TABLE IF NOT EXISTS monitor_stats (
      monitor_id       INT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
      uptime_24h       NUMERIC(5,2) DEFAULT 100.00,
      avg_latency_24h  INT DEFAULT 0,
      last_updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_monitor_stats_updated ON monitor_stats(last_updated_at);

    -- 2. Add last_checked to monitors table for faster list view
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_checked TIMESTAMP;
    
    -- 3. Pre-populate monitor_stats with existing monitors
    INSERT INTO monitor_stats (monitor_id)
    SELECT id FROM monitors
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE monitors DROP COLUMN IF EXISTS last_checked;
    DROP TABLE IF EXISTS monitor_stats CASCADE;
  `);
};
