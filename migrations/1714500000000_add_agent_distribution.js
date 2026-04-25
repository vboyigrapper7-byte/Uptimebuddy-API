/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Table to track agent releases
  pgm.createTable('agent_releases', {
    id:                 'id',
    version:            { type: 'varchar(50)',  notNull: true, unique: true },
    is_stable:          { type: 'boolean',      notNull: true, default: true },
    rollout_percentage: { type: 'integer',      notNull: true, default: 100 },
    release_notes:      { type: 'text' },
    created_at:         { type: 'timestamp',    notNull: true, default: pgm.func('current_timestamp') },
  });

  // 2. Table to track binary metadata per platform
  pgm.createTable('agent_binaries', {
    id:              'id',
    release_id:      { type: 'integer',      notNull: true, references: '"agent_releases"', onDelete: 'cascade' },
    platform:        { type: 'varchar(50)',  notNull: true },
    architecture:    { type: 'varchar(50)',  notNull: true },
    file_path:       { type: 'text',         notNull: true },
    sha256:          { type: 'varchar(64)',  notNull: true },
    download_count:  { type: 'integer',      notNull: true, default: 0 },
  });

  pgm.createIndex('agent_binaries', ['platform', 'architecture']);
  pgm.createIndex('agent_binaries', 'release_id');

  // 3. Update agents table
  pgm.addColumns('agents', {
    agent_type:    { type: 'varchar(20)',  notNull: true, default: 'node' },
    agent_version: { type: 'varchar(50)',  notNull: false },
    public_ip:     { type: 'varchar(45)',  notNull: false },
    private_ip:    { type: 'varchar(45)',  notNull: false },
    hostname:      { type: 'varchar(255)', notNull: false },
    os_type:       { type: 'varchar(50)',  notNull: false },
  });

  // 4. Update agent_metrics table with hardware stats
  pgm.addColumns('agent_metrics', {
    ram_total_mb:  { type: 'integer', notNull: false },
    disk_total_gb: { type: 'numeric', notNull: false },
    disk_free_gb:  { type: 'numeric', notNull: false },
    uptime_seconds: { type: 'bigint',  notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('agents', ['agent_type', 'agent_version']);
  pgm.dropTable('agent_binaries');
  pgm.dropTable('agent_releases');
};
