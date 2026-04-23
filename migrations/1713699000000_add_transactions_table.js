exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            order_id VARCHAR(255) UNIQUE NOT NULL,
            payment_id VARCHAR(255) UNIQUE,
            plan_id VARCHAR(50) NOT NULL,
            amount INTEGER NOT NULL,
            status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'paid', 'failed'
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Index for fast lookup during verification and webhooks
        CREATE INDEX IF NOT EXISTS idx_transactions_order_id ON transactions(order_id);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE IF EXISTS transactions;
    `);
};
