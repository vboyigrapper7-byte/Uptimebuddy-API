exports.up = (pgm) => {
    // 1. User Table Enhancements for Subscriptions
    pgm.addColumns('users', {
        subscription_id: { type: 'varchar(255)', default: null },
        subscription_status: { type: 'varchar(50)', default: null },
        cancel_at_period_end: { type: 'boolean', default: false }
    });

    // 2. Transaction Table Enhancements
    pgm.addColumns('transactions', {
        subscription_id: { type: 'varchar(255)', default: null }
    });

    // 3. Webhook Idempotency Table
    pgm.createTable('processed_webhooks', {
        id: 'id',
        event_id: { type: 'varchar(255)', notNull: true, unique: true },
        processed_at: {
            type: 'timestamp',
            notNull: true,
            default: pgm.func('current_timestamp'),
        },
    });

    pgm.createIndex('processed_webhooks', 'event_id');
};

exports.down = (pgm) => {
    pgm.dropTable('processed_webhooks');
    pgm.dropColumns('transactions', ['subscription_id']);
    pgm.dropColumns('users', ['subscription_id', 'subscription_status', 'cancel_at_period_end']);
};
