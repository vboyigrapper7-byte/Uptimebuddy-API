require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/uptimebuddy' });

async function runMigrations() {
  try {
    console.log("Adding keyword column to monitors...");
    await pool.query("ALTER TABLE monitors ADD COLUMN IF NOT EXISTS keyword VARCHAR(255);");

    console.log("Creating monitor_metrics table...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitor_metrics (
        monitor_id INT REFERENCES monitors(id),
        recorded_at TIMESTAMP NOT NULL,
        response_time_ms INT,
        status VARCHAR(50),
        PRIMARY KEY(monitor_id, recorded_at)
      );
    `);
    
    // Create an index for faster latency charting lookups
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_monitor_metrics_time ON monitor_metrics(monitor_id, recorded_at DESC);`);
    
    console.log("Database migrations applied successfully.");
  } catch(e) {
    console.error("Migration failed", e);
  } finally {
    process.exit(0);
  }
}

runMigrations();
