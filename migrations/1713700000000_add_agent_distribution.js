/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Table to track agent releases
  pgm.createTable('agent_releases', {
    id:              'id',
    version:         { type: 'varchar(50)',  notNull: true, unique: true },
    is_stable:       { type: 'boolean',      notNull: true, default: true },
    release_notes:   { type: 'text' },
    created_at:      { type: 'timestamp',    notNull: true, default: pgm.func('current_timestamp') },
  });

  // 2. Table to track binary metadata per platform
  pgm.createTable('agent_binaries', {
    id:              'id',
    release_id:      { type: 'integer',      notNull: true, references: '"agent_releases"', onDelete: 'cascade' },
    os:              { type: 'varchar(50)',  notNull: true },
    arch:            { type: 'varchar(50)',  notNull: true },
    file_path:       { type: 'text',         notNull: true }, // Local path or S3 URL
    sha256:          { type: 'varchar(64)',  notNull: true },
    download_count:  { type: 'integer',      notNull: true, default: 0 },
  });

  pgm.createIndex('agent_binaries', ['os', 'arch']);
  pgm.createIndex('agent_binaries', 'release_id');

  // 3. Update agents table to track version and type
  pgm.addColumns('agents', {
    agent_type:    { type: 'varchar(20)',  notNull: true, default: 'node' }, // 'node' or 'go'
    agent_version: { type: 'varchar(50)',  notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('agents', ['agent_type', 'agent_version']);
  pgm.dropTable('agent_binaries');
  pgm.dropTable('agent_releases');
};
