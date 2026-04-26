-- =============================================================================
-- Monitor Hub — Production Database Schema
-- Run once on a fresh database. Safe to re-run (uses IF NOT EXISTS).
-- =============================================================================

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    tier          VARCHAR(50)  DEFAULT 'free',
    role          VARCHAR(20)  DEFAULT 'customer',
    api_key_hash  VARCHAR(255),
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ── Refresh Tokens (Server-side session management) ──────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INT          REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMP    NOT NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ── Monitors (web/TCP checks) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitors (
    id               SERIAL PRIMARY KEY,
    user_id          INT          REFERENCES users(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    type             VARCHAR(50)  NOT NULL CHECK (type IN ('http','https','keyword','port','ping')),
    category         VARCHAR(20)  DEFAULT 'uptime',
    target           VARCHAR(500) NOT NULL,
    keyword          VARCHAR(255),
    interval_seconds INT          DEFAULT 300 CHECK (interval_seconds >= 30 AND interval_seconds <= 86400),
    method           VARCHAR(10)  DEFAULT 'GET',
    headers          TEXT,         -- Stored as JSON string
    body             TEXT,
    timeout_ms       INT          DEFAULT 10000,
    max_retries      INT          DEFAULT 3,
    expected_status  VARCHAR(50)  DEFAULT '200-399',
    threshold_ms     INT          DEFAULT 0,
    region           VARCHAR(50)  DEFAULT 'Global',
    priority         VARCHAR(20)  DEFAULT 'medium',
    status           VARCHAR(50)  DEFAULT 'pending',
    assertion_config JSONB,
    escalation_state JSONB        DEFAULT '{"step": 0, "last_trigger": null}',
    created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Ensure existing installs have the new columns (safe migrations)
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'uptime';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'GET';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS headers TEXT;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS timeout_ms INT DEFAULT 10000;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS max_retries INT DEFAULT 3;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS expected_status VARCHAR(50) DEFAULT '200-399';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS threshold_ms INT DEFAULT 0;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS region VARCHAR(50) DEFAULT 'Global';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS assertion_config JSONB;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS escalation_state JSONB DEFAULT '{"step": 0, "last_trigger": null}';
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_checked TIMESTAMP;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_monitors_user_id    ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_status      ON monitors(status);

-- ── Monitor metrics (latency history) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitor_metrics (
    monitor_id       INT          REFERENCES monitors(id) ON DELETE CASCADE,
    recorded_at      TIMESTAMP    NOT NULL,
    response_time_ms INT,
    status           VARCHAR(50),
    status_code      INT,
    error_message    TEXT,
    PRIMARY KEY (monitor_id, recorded_at)
);

ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS status_code INT;
ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_monitor_metrics_time ON monitor_metrics(monitor_id, recorded_at DESC);

-- ── Incidents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents (
    id            SERIAL PRIMARY KEY,
    monitor_id    INT          REFERENCES monitors(id) ON DELETE CASCADE,
    started_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at   TIMESTAMP,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id ON incidents(monitor_id, started_at DESC);

-- ── Agents (physical server monitoring) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
    id           SERIAL PRIMARY KEY,
    user_id      INT          REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL DEFAULT 'Unnamed Server',
    server_group VARCHAR(255) DEFAULT 'Ungrouped',
    agent_token  VARCHAR(255) UNIQUE NOT NULL,
    status       VARCHAR(50)  DEFAULT 'pending',
    last_seen    TIMESTAMP,
    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    public_ip    VARCHAR(45),
    private_ip   VARCHAR(45),
    hostname     VARCHAR(255),
    os_type      VARCHAR(50)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ── Monitor Stats (Precomputed for Performance) ───────────────────────────
CREATE TABLE IF NOT EXISTS monitor_stats (
    monitor_id      INT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
    uptime_24h      NUMERIC(5,2) DEFAULT 100.00,
    avg_latency_24h INTEGER DEFAULT 0,
    last_updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_user_id     ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_token       ON agents(agent_token);

-- ── Agent metrics (CPU/RAM/Disk telemetry) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_metrics (
    agent_id     INT              REFERENCES agents(id) ON DELETE CASCADE,
    recorded_at  TIMESTAMP        NOT NULL,
    cpu_percent  NUMERIC(5,2),
    ram_mb       INT,
    ram_total_mb INT,
    ram_percent  NUMERIC(5,2),
    disk_percent NUMERIC(5,2),
    disk_total_gb NUMERIC(10,2),
    disk_free_gb  NUMERIC(10,2),
    net_rx_mb     NUMERIC(8,3)    DEFAULT 0,
    net_tx_mb     NUMERIC(8,3)    DEFAULT 0,
    uptime_seconds BIGINT         DEFAULT 0,
    process_count  INT            DEFAULT 0,
    PRIMARY KEY (agent_id, recorded_at)
);

-- Add ram_total_mb to existing installs (safe — IF NOT EXISTS avoids error on fresh installs)
ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_total_mb INT;

CREATE INDEX IF NOT EXISTS idx_agent_metrics_time ON agent_metrics(agent_id, recorded_at DESC);

-- ── Webhooks (alert delivery endpoints) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
    id         SERIAL PRIMARY KEY,
    user_id    INT          REFERENCES users(id) ON DELETE CASCADE,
    provider   VARCHAR(50)  NOT NULL CHECK (provider IN ('slack','discord','telegram')),
    url        TEXT         NOT NULL,
    created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);

-- ── OTPs (Temporary signup verification) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
    id              SERIAL PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    otp             TEXT NOT NULL,
    hashed_password TEXT NOT NULL,
    expires_at      TIMESTAMP NOT NULL,
    attempts        INT DEFAULT 0,
    last_sent_at    TIMESTAMP DEFAULT NOW(),
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);

