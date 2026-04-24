exports.up = (pgm) => {
    pgm.sql(`
        -- ── Alert Settings (Global per user) ──────────────────────────────────
        CREATE TABLE IF NOT EXISTS alert_settings (
            id                SERIAL PRIMARY KEY,
            user_id           INT          REFERENCES users(id) ON DELETE CASCADE,
            on_down           BOOLEAN      DEFAULT TRUE,
            on_up             BOOLEAN      DEFAULT TRUE,
            on_warning        BOOLEAN      DEFAULT FALSE,
            threshold_retries INT          DEFAULT 3,
            cooldown_mins     INT          DEFAULT 5,
            reminder_mins     INT          DEFAULT 30,
            emails_enabled    BOOLEAN      DEFAULT TRUE,
            webhooks_enabled  BOOLEAN      DEFAULT TRUE,
            updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id)
        );

        -- ── Alert Logs (History for dashboard) ───────────────────────────────
        CREATE TABLE IF NOT EXISTS alert_logs (
            id               SERIAL PRIMARY KEY,
            user_id          INT          REFERENCES users(id) ON DELETE CASCADE,
            monitor_id       INT          REFERENCES monitors(id) ON DELETE CASCADE,
            alert_type       VARCHAR(20)  NOT NULL, -- 'down', 'up', 'warning', 'reminder'
            status           VARCHAR(20)  NOT NULL, -- 'success', 'failed'
            error_message    TEXT,
            provider         VARCHAR(50), -- 'email', 'webhook', 'slack', etc.
            delivered_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
        );

        -- ── Per-monitor Alert Toggle ─────────────────────────────────────────
        ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;

        -- Create indices for performance
        CREATE INDEX IF NOT EXISTS idx_alert_logs_user_id ON alert_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_alert_logs_monitor_id ON alert_logs(monitor_id);
        CREATE INDEX IF NOT EXISTS idx_alert_settings_user_id ON alert_settings(user_id);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE IF EXISTS alert_logs;
        DROP TABLE IF EXISTS alert_settings;
        ALTER TABLE monitors DROP COLUMN IF EXISTS alerts_enabled;
    `);
};
