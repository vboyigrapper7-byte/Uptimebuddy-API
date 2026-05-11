exports.up = (pgm) => {
    pgm.createTable('archive_settings', {
        user_id: { type: 'int', primaryKey: true, references: '"users"', onDelete: 'CASCADE' },
        provider: { type: 'varchar(50)', notNull: true, default: 's3' },
        credentials_encrypted: { type: 'text' }, 
        retention_days: { type: 'int', default: 30 },
        auto_archive: { type: 'boolean', default: false },
        compression_enabled: { type: 'boolean', default: true },
        encryption_enabled: { type: 'boolean', default: false },
        encryption_key_encrypted: { type: 'text' },
        updated_at: { type: 'timestamp', default: pgm.func('current_timestamp') }
    });

    pgm.createTable('archives', {
        id: 'id',
        user_id: { type: 'int', references: '"users"', onDelete: 'CASCADE' },
        data_type: { type: 'varchar(50)', notNull: true }, 
        file_name: { type: 'varchar(255)' },
        provider: { type: 'varchar(50)', notNull: true },
        file_size_bytes: { type: 'bigint' },
        record_count: { type: 'int' },
        status: { type: 'varchar(50)', default: 'pending' }, 
        provider_file_id: { type: 'varchar(255)' },
        checksum: { type: 'varchar(100)' },
        created_at: { type: 'timestamp', default: pgm.func('current_timestamp') },
        verified_at: { type: 'timestamp' }
    });

    pgm.createIndex('archives', 'user_id');
    pgm.createIndex('archives', 'status');
};

exports.down = (pgm) => {
    pgm.dropTable('archives');
    pgm.dropTable('archive_settings');
};
