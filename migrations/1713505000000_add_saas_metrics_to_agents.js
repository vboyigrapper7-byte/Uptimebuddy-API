/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Add IP and Metadata columns to agents table
  pgm.sql(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_ip varchar(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_ip varchar(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS prev_public_ip varchar(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS prev_private_ip varchar(45);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS ip_changed_at timestamp;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS hostname varchar(255);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS os_type varchar(50);
  `);

  // 2. Add detailed disk metrics to agent_metrics table
  pgm.sql(`
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_total_gb numeric(10,2);
    ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_free_gb numeric(10,2);
  `);

  // 3. Create index for last_seen to optimize status lookups
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen);`);
};

exports.down = (pgm) => {
  pgm.dropIndex('agents', 'last_seen', { name: 'idx_agents_last_seen' });
  pgm.dropColumns('agent_metrics', ['disk_total_gb', 'disk_free_gb']);
  pgm.dropColumns('agents', [
    'public_ip',
    'private_ip',
    'prev_public_ip',
    'prev_private_ip',
    'ip_changed_at',
    'hostname',
    'os_type'
  ]);
};
