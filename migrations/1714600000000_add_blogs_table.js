exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS blogs (
            id SERIAL PRIMARY KEY,
            slug VARCHAR(255) UNIQUE NOT NULL,
            title VARCHAR(255) NOT NULL,
            excerpt TEXT,
            content TEXT NOT NULL,
            category VARCHAR(100) DEFAULT 'General',
            cover_image VARCHAR(500),
            published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            author_name VARCHAR(100) DEFAULT 'Monitor Hub Team',
            author_role VARCHAR(100) DEFAULT 'DevOps Experts',
            author_image VARCHAR(500) DEFAULT 'https://i.pravatar.cc/150?u=monitorhub'
        );
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('blogs');
};
