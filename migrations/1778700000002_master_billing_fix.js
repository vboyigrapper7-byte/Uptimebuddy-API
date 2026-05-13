exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        -- 1. Fix Users Table: Add missing tracking columns
        ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
        ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50);
        
        -- 2. Fix Transactions Table: Support Subscriptions
        ALTER TABLE transactions ALTER COLUMN order_id DROP NOT NULL;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255);
        
        -- 3. Safety: Add index for subscription lookups
        CREATE INDEX IF NOT EXISTS idx_transactions_subscription_id ON transactions(subscription_id);
        
        -- 4. Ensure existing rows have a default updated_at
        UPDATE users SET updated_at = NOW() WHERE updated_at IS NULL;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE transactions ALTER COLUMN order_id SET NOT NULL;
    `);
};
