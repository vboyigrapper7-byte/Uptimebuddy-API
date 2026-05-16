exports.up = (pgm) => {
  pgm.createTable('reports', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'cascade' },
    monitor_id: { type: 'integer', references: '"monitors"', onDelete: 'set null' },
    type: { type: 'varchar(50)', notNull: true }, // e.g., 'sla', 'uptime', 'incident'
    status: { type: 'varchar(20)', notNull: true, default: 'pending' }, // 'pending', 'processing', 'completed', 'failed'
    url: { type: 'text' },
    config: { type: 'jsonb' }, // stores range, metrics etc.
    error: { type: 'text' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    completed_at: { type: 'timestamp' },
  });
  pgm.createIndex('reports', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('reports');
};
