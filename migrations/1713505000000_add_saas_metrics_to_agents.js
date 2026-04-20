/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Add IP and Metadata columns to agents table
  pgm.addColumns('agents', {
    public_ip:       { type: 'varchar(45)',  notNull: false },
    private_ip:      { type: 'varchar(45)',  notNull: false },
    prev_public_ip:  { type: 'varchar(45)',  notNull: false },
    prev_private_ip: { type: 'varchar(45)',  notNull: false },
    ip_changed_at:   { type: 'timestamp',    notNull: false },
    hostname:        { type: 'varchar(255)', notNull: false },
    os_type:         { type: 'varchar(50)',  notNull: false },
  });

  // 2. Add detailed disk metrics to agent_metrics table
  pgm.addColumns('agent_metrics', {
    disk_total_gb: { type: 'numeric(10,2)', notNull: false },
    disk_free_gb:  { type: 'numeric(10,2)', notNull: false },
  });

  // 3. Create index for last_seen to optimize status lookups
  pgm.createIndex('agents', 'last_seen', { name: 'idx_agents_last_seen' });
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
