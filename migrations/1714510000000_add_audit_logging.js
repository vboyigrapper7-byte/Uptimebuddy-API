exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id) ON DELETE SET NULL,
            admin_id INT REFERENCES users(id) ON DELETE SET NULL,
            action VARCHAR(100) NOT NULL,
            entity_type VARCHAR(50),
            entity_id VARCHAR(100),
            old_value JSONB,
            new_value JSONB,
            ip_address VARCHAR(45),
            user_agent TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
        CREATE INDEX idx_audit_logs_action ON audit_logs(action);
        CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS audit_logs;`);
};
