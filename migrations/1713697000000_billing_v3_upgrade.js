exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.sql(`
        -- 1. Extend Users table for Billing
        ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id VARCHAR(50) DEFAULT 'free';

        -- 2. Add Category to Monitors
        -- We use VARCHAR for now to avoid ENUM migration complexities while live, 
        -- but enforce values in the application layer.
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'uptime';
        
        -- 3. Soft Deletion Support
        ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMP;
        ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMP;

        -- 4. Initial Migration of existing monitor types to categories
        -- All existing are 'uptime' by default, but if someone used 'http' with headers/body, 
        -- we might consider them API later. For now, keep it safe.
        UPDATE monitors SET category = 'uptime' WHERE category IS NULL;
        
        -- 5. Existing user migration: Grant 30-day Pro trial
        UPDATE users SET 
            tier = 'pro',
            plan_id = 'pro_trial',
            trial_ends_at = NOW() + INTERVAL '30 days'
        WHERE trial_ends_at IS NULL;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE monitor_metrics DROP COLUMN IF EXISTS deletion_scheduled_at;
        ALTER TABLE agent_metrics DROP COLUMN IF EXISTS deletion_scheduled_at;
        ALTER TABLE monitors DROP COLUMN IF EXISTS category;
        ALTER TABLE users DROP COLUMN IF EXISTS trial_ends_at;
        ALTER TABLE users DROP COLUMN IF EXISTS subscription_status;
        ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
        ALTER TABLE users DROP COLUMN IF EXISTS stripe_subscription_id;
        ALTER TABLE users DROP COLUMN IF EXISTS plan_id;
    `);
};
