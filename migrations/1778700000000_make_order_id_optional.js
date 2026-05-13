exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        -- Allow order_id to be NULL because subscriptions use subscription_id instead
        ALTER TABLE transactions ALTER COLUMN order_id DROP NOT NULL;
        
        -- Also ensure subscription_id exists (safety check)
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255) UNIQUE;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE transactions ALTER COLUMN order_id SET NOT NULL;
    `);
};
