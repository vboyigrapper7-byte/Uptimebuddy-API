exports.up = (pgm) => {
    // 1. User Table Enhancements (Hardened with IF NOT EXISTS)
    pgm.sql(`
        ALTER TABLE "users" 
        ADD COLUMN IF NOT EXISTS "subscription_id" varchar(255) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "subscription_status" varchar(50) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean DEFAULT false;
    `);

    // 2. Transaction Table Enhancements (Hardened with IF NOT EXISTS)
    pgm.sql(`
        ALTER TABLE "transactions" 
        ADD COLUMN IF NOT EXISTS "subscription_id" varchar(255) DEFAULT NULL;
    `);

    // 3. Webhook Idempotency Table (Hardened with ifNotExists)
    pgm.createTable('processed_webhooks', {
        id: 'id',
        event_id: { type: 'varchar(255)', notNull: true, unique: true },
        processed_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    }, { ifNotExists: true });

    // 4. Index for Webhooks (Hardened with ifNotExists)
    pgm.createIndex('processed_webhooks', 'event_id', { ifNotExists: true });
};

exports.down = (pgm) => {
    pgm.dropTable('processed_webhooks', { ifExists: true });
    pgm.dropColumns('transactions', ['subscription_id'], { ifExists: true });
    pgm.dropColumns('users', ['subscription_id', 'subscription_status', 'cancel_at_period_end'], { ifExists: true });
};
