/**
 * Migration: Add extended agent metrics columns
 * Adds network I/O, uptime, and process count columns to agent_metrics.
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_rx_mb      NUMERIC(10,2);
        ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_tx_mb      NUMERIC(10,2);
        ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS uptime_seconds BIGINT;
        ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS process_count  INT;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE agent_metrics DROP COLUMN IF EXISTS net_rx_mb;
        ALTER TABLE agent_metrics DROP COLUMN IF EXISTS net_tx_mb;
        ALTER TABLE agent_metrics DROP COLUMN IF EXISTS uptime_seconds;
        ALTER TABLE agent_metrics DROP COLUMN IF EXISTS process_count;
    `);
};
