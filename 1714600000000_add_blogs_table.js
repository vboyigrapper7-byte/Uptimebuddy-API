exports.up = (pgm) => {
    pgm.createTable('blogs', {
        id: 'id',
        slug: { type: 'varchar(255)', notNull: true, unique: true },
        title: { type: 'varchar(255)', notNull: true },
        excerpt: { type: 'text' },
        content: { type: 'text', notNull: true },
        category: { type: 'varchar(100)', default: 'General' },
        cover_image: { type: 'varchar(500)' },
        published_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
        author_name: { type: 'varchar(100)', default: 'Monitor Hub Team' },
        author_role: { type: 'varchar(100)', default: 'DevOps Experts' },
        author_image: { type: 'varchar(500)', default: 'https://i.pravatar.cc/150?u=monitorhub' }
    });
};

exports.down = (pgm) => {
    pgm.dropTable('blogs');
};
