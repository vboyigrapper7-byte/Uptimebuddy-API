-- =============================================================================
-- UptimeBuddy — Production Database Schema
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
    target           VARCHAR(500) NOT NULL,
    keyword          VARCHAR(255),
    interval_seconds INT          DEFAULT 300 CHECK (interval_seconds >= 30 AND interval_seconds <= 86400),
    status           VARCHAR(50)  DEFAULT 'pending',
    created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monitors_user_id    ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_status      ON monitors(status);

-- ── Monitor metrics (latency history) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitor_metrics (
    monitor_id       INT          REFERENCES monitors(id) ON DELETE CASCADE,
    recorded_at      TIMESTAMP    NOT NULL,
    response_time_ms INT,
    status           VARCHAR(50),
    PRIMARY KEY (monitor_id, recorded_at)
);

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
    last_seen    TIMESTAMP
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
    disk_percent NUMERIC(5,2),
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
