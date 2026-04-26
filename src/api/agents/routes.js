const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const auditService = require('../../core/auth/auditService');
const { requireAuth, requireApiKey } = require('../auth/middleware');

// ── SSRF / private‑IP guard ─────────────────────────────────────────────
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;

// ── Metric range guard ───────────────────────────────────────────────────
function validateMetrics(metrics) {
    // Robust parsing for case where metrics arrive as strings
    const cpu = Number(metrics.cpu_percent);
    const ram = Number(metrics.ram_mb);
    const disk = Number(metrics.disk_percent);

    if (isNaN(cpu) || cpu < 0 || cpu > 100) return false;
    if (isNaN(disk) || disk < 0 || disk > 100) return false;
    if (isNaN(ram) || ram < 0 || ram > 4194304) return false;
    return true;
}

// ── Agent dynamic status helper ───────────────────────────────────────────
function getDynamicAgentStatus(agent) {
    if (!agent.last_seen) return agent.status;
    const now = Date.now();
    const secondsSinceSeen = (now - new Date(agent.last_seen).getTime()) / 1000;
    
    // If we've seen it recently, it's UP (overrides 'pending')
    if (secondsSinceSeen < 90) return 'up';
    
    // If it was pending but hasn't reported, stay pending
    if (agent.status === 'pending') return 'pending';
    
    return 'down';
}

async function agentRoutes(fastify, options) {

    // ────────────────────────────────────────────────────────────────────
    // ONE-TIME ACTIVATION ROUTE (Visit once to setup database)
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/internal/seed-distribution', async (request, reply) => {
        try {
            await fastify.db.query(`
                -- 0. Repair users table (Crucial for Auth)
                ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
                ALTER TABLE users ADD COLUMN IF NOT EXISTS status_slug VARCHAR(50);
                ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id VARCHAR(50);
                ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expiry TIMESTAMP;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255);
                ALTER TABLE users ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'email';

                -- 1. Repair monitors table
                ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_checked TIMESTAMP;
                ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMP;
                ALTER TABLE monitors ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'uptime';
                ALTER TABLE monitors ADD COLUMN IF NOT EXISTS assertion_config JSONB;

                -- 2. Repair monitor_metrics
                ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS status_code INT;
                ALTER TABLE monitor_metrics ADD COLUMN IF NOT EXISTS error_message TEXT;

                -- 3. Repair agents table (Fixing Heartbeat 500 errors)
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_ip varchar(45);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_ip varchar(45);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS hostname varchar(255);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS os_type varchar(50);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) DEFAULT 'node';
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_version VARCHAR(20);

                -- 4. Repair monitor_stats
                CREATE TABLE IF NOT EXISTS monitor_stats (
                    monitor_id      INT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
                    uptime_24h      NUMERIC(5,2) DEFAULT 100.00,
                    avg_latency_24h INTEGER DEFAULT 0,
                    last_updated_at TIMESTAMP DEFAULT NOW()
                );
                
                -- 5. Repair agent_metrics
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_total_mb integer;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_percent numeric(5,2);
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_total_gb numeric;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_free_gb numeric;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_rx_mb numeric(8,3) DEFAULT 0;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS net_tx_mb numeric(8,3) DEFAULT 0;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS uptime_seconds bigint DEFAULT 0;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS process_count integer DEFAULT 0;

                -- 6. Repair Alerting System (Fixing Ingest 500 errors)
                CREATE TABLE IF NOT EXISTS alert_settings (
                    user_id           INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    on_down           BOOLEAN DEFAULT TRUE,
                    on_up             BOOLEAN DEFAULT TRUE,
                    on_warning        BOOLEAN DEFAULT FALSE,
                    threshold_retries INT DEFAULT 3,
                    cooldown_mins     INT DEFAULT 5,
                    reminder_mins     INT DEFAULT 30,
                    emails_enabled    BOOLEAN DEFAULT TRUE,
                    webhooks_enabled  BOOLEAN DEFAULT TRUE,
                    updated_at        TIMESTAMP DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS alert_history (
                    id           SERIAL PRIMARY KEY,
                    user_id      INT REFERENCES users(id) ON DELETE CASCADE,
                    monitor_id   INT REFERENCES monitors(id) ON DELETE CASCADE,
                    type         VARCHAR(50), 
                    message      TEXT,
                    severity     VARCHAR(20) DEFAULT 'info',
                    delivered_at TIMESTAMP DEFAULT NOW()
                );

                -- 7. Indexes
                CREATE INDEX IF NOT EXISTS idx_agent_metrics_compound ON agent_metrics (agent_id, recorded_at DESC);
                CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors(status);
                CREATE INDEX IF NOT EXISTS idx_monitor_metrics_time ON monitor_metrics(monitor_id, recorded_at DESC);
                CREATE INDEX IF NOT EXISTS idx_alert_history_time ON alert_history(delivered_at DESC);
            `);

            const releaseUrl = 'https://github.com/vboyigrapper7-byte/Uptimebuddy-API/releases/download/v1.0/MonitorHubAgent.msi';
            
            // 1. Setup Release
            await fastify.db.query(`
                INSERT INTO agent_releases (version, is_stable, rollout_percentage)
                VALUES ('1.0.0', true, 100)
                ON CONFLICT (version) DO NOTHING;
            `);

            // 2. Setup Windows MSI (Dual-Column Support)
            await fastify.db.query(`
                INSERT INTO agent_binaries (release_id, platform, os, architecture, arch, file_path, sha256)
                VALUES (
                    (SELECT id FROM agent_releases WHERE version = '1.0.0' LIMIT 1),
                    'windows', 'windows', 'amd64', 'amd64',
                    '${releaseUrl}',
                    'N/A'
                )
                ON CONFLICT ON CONSTRAINT unique_platform_arch_release DO UPDATE SET file_path = EXCLUDED.file_path;
            `);

            // 3. Setup Linux Agent (Dual-Column Support)
            await fastify.db.query(`
                INSERT INTO agent_binaries (release_id, platform, os, architecture, arch, file_path, sha256)
                VALUES (
                    (SELECT id FROM agent_releases WHERE version = '1.0.0' LIMIT 1),
                    'linux', 'linux', 'amd64', 'amd64',
                    '/api/v1/agents/scripts/linux',
                    'N/A'
                )
                ON CONFLICT ON CONSTRAINT unique_platform_arch_release DO UPDATE SET file_path = EXCLUDED.file_path;
            `);

            return { success: true, message: "Database REPAIRED and MAPPED to GitHub successfully!" };
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // Check if an agent has connected (Used by the onboarding wizard)
    fastify.get('/check-token', async (request, reply) => {
        const { token } = request.query;
        if (!token) return reply.status(400).send({ error: 'Token is required' });

        try {
            const res = await fastify.db.query(
                'SELECT id, last_seen, status, hostname, public_ip FROM agents WHERE agent_token = $1',
                [token]
            );

            if (res.rows.length === 0) {
                return reply.send({ success: true, connected: false, message: 'Token not found in database' });
            }
            
            const agent = res.rows[0];
            const isConnected = agent.last_seen !== null;
            
            return reply.send({ 
                success: true,
                connected: isConnected,
                status: isConnected ? 'up' : 'pending',
                agent_id: agent.id,
                hostname: agent.hostname,
                public_ip: agent.public_ip,
                last_seen: agent.last_seen
            });
        } catch (err) {
            fastify.log.error(err, 'check-token error');
            return reply.status(500).send({ error: err.message });
        }
    });

    // ────────────────────────────────────────────────────────────────────
    // PUBLIC — Agent ingest (uses agent_token as auth, not JWT)
    // ────────────────────────────────────────────────────────────────────
    fastify.post('/ingest', {
        config: {
            rateLimit: { max: 60, timeWindow: '1 minute' },
        },
        preHandler: async (request, reply) => {
            if (request.headers['x-api-key']) {
                return requireApiKey(request, reply);
            }
        }
    }, async (request, reply) => {
        // Extract agent_token from header (preferred) or body (legacy)
        const agent_token = request.headers['x-agent-token'] || request.body?.agent_token;
        const agent_type  = request.headers['x-agent-type']  || request.body?.agent_type || 'node';
        const agent_version = request.headers['x-agent-version'] || request.body?.agent_version || null;
        const { metrics } = request.body || {};

        if (!agent_token || !metrics) {
            return reply.status(400).send({ error: 'agent_token and metrics are required' });
        }

        if (!validateMetrics(metrics)) {
            return reply.status(400).send({ error: 'Invalid metric values' });
        }

        try {
            // 1. Initial Lookup (Find agent and check previous status for alerting)
            const res = await fastify.db.query(
                'SELECT id, user_id, status, name FROM agents WHERE agent_token = $1',
                [agent_token]
            );

            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Agent not found' });
            }

            const agent = res.rows[0];
            const agentId = agent.id;
            const userId  = agent.user_id;
            const prevStatus = agent.status;
            const hostname = request.body?.hostname || metrics?.hostname || null;
            const os_type  = request.body?.os_type || metrics?.os || null;
            const public_ip = request.ip;

            const recordedAt = new Date();

            // 1.5 Update Agent State (Heartbeat Priority - Ensures 'Online' Status)
            await fastify.db.query(`
                UPDATE agents 
                SET last_seen = NOW(), 
                    status = 'up', 
                    agent_type = $2, 
                    agent_version = $3,
                    hostname = COALESCE($4, hostname),
                    os_type = COALESCE($5, os_type),
                    public_ip = $6
                WHERE id = $1`, 
                [agentId, agent_type, agent_version, hostname, os_type, public_ip]
            );

            // 2. Save Metrics (Hardware Aware for Accurate Dashboard Stats)
            const computed_ram_percent = metrics.ram_percent !== undefined ? metrics.ram_percent : (metrics.ram_total_mb ? (metrics.ram_mb / metrics.ram_total_mb) * 100 : 0);
            
            try {
                await fastify.db.query(`
                    INSERT INTO agent_metrics (
                        agent_id, recorded_at, cpu_percent, ram_mb, ram_percent, disk_percent, 
                        net_rx_mb, net_tx_mb, process_count,
                        ram_total_mb, disk_total_gb, disk_free_gb, uptime_seconds
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                    [
                        agentId, recordedAt, 
                        metrics.cpu_percent, metrics.ram_mb, computed_ram_percent, metrics.disk_percent,
                        metrics.net_rx_mb || 0, metrics.net_tx_mb || 0, metrics.process_count || 0,
                        metrics.ram_total_mb || null, metrics.disk_total_gb || null, metrics.disk_free_gb || null, metrics.uptime_seconds || 0
                    ]
                );
            } catch (metricErr) {
                fastify.log.warn({ agentId, error: metricErr.message }, 'Metrics insertion failed - proceeding with heartbeat only');
            }

            // 4. Alert Trigger (Up/Down Logic)
            if (prevStatus === 'down' || prevStatus === 'pending') {
                const teamRes = await fastify.db.query('SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1', [userId]);
                const teamId = teamRes.rows[0]?.team_id;

                await fastify.db.query(
                    'INSERT INTO alert_history (user_id, monitor_id, type, message, severity) VALUES ($1, $2, $3, $4, $5)',
                    [userId, null, 'server_status', `[${agent.name}] System Online: Server is now UP and reporting telemetry.`, 'critical']
                );
                
                // Professional Audit Logging
                if (teamId) {
                    await auditService.log(userId, teamId, 'server_recovered', { name: agent.name, id: agentId });
                }
            }

            return reply.send({ success: true });
        } catch (err) {
            fastify.log.error(err, 'Agent ingest fatal error');
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    // ────────────────────────────────────────────────────────────────────
    // PUBLIC — Agent script download
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/script', async (request, reply) => {
        // Primary: agent.js bundled inside the backend src directory (works on Render)
        const primaryPath  = path.resolve(__dirname, '../../agent.js');
        // Fallback: monorepo sibling path (works locally)
        const fallbackPath = path.resolve(__dirname, '../../../../monitorhub-agent/agent.js');
        const scriptPath   = fs.existsSync(primaryPath) ? primaryPath : fallbackPath;
        try {
            const content = await fs.promises.readFile(scriptPath, 'utf-8');
            return reply.type('application/javascript').send(content);
        } catch (err) {
            fastify.log.error(err, 'Could not serve agent script');
            return reply.status(500).send({ error: 'Agent script not available' });
        }
    });

    // ────────────────────────────────────────────────────────────────────
    // PUBLIC — Windows Native Service Installer Script
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/windows-service.js', async (request, reply) => {
        const script = `
const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'MonitorHubAgent',
  description: 'Monitor Hub hardware telemetry agent',
  script: path.join(__dirname, 'agent.js')
});

svc.on('install', () => {
  console.log('[Service] Installed successfully into Windows SCM.');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('[Service] Service already exists. Restarting...');
  svc.restart();
});

svc.on('start', () => {
  console.log('[Service] Monitor Hub Agent is now running in the background!');
});

svc.install();`;
        return reply.type('application/javascript').send(script);
    });

    // ────────────────────────────────────────────────────────────────────
    // PUBLIC — Installer script generators (token needed to download)
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/install_windows.bat', async (request, reply) => {
        const { token, host } = request.query;
        if (!token) return reply.status(400).send('Agent token is required');

        const hostUrl = host || process.env.PUBLIC_API_URL || 'https://api.monitorhubs.com';
        const script = `@echo off
setlocal enabledelayedexpansion

:: ── Elevation Check ──────────────────────────────────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Please run this script as Administrator.
    pause
    exit /b
)

echo ========================================================
echo  MonitorHub Enterprise Agent Setup (Windows Pro)
echo ========================================================

:: ── Directory Setup ────────────────────────────────────────────────────────
set "INSTALL_DIR=C:\\Program Files\\MonitorHub"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
cd /d "%INSTALL_DIR%"

:: ── Multi-Stage Download Engine ──────────────────────────────────────────
echo [INFO] Downloading Agent Engine...
set "AGENT_URL=${hostUrl}/api/v1/agents/scripts/windows"

:: Try Curl (Fastest)
curl.exe --ssl-no-revoke -f -s -L -o "monitorhub-agent.ps1" "%AGENT_URL%"

:: Try PowerShell Fallback (Most compatible)
if not exist "monitorhub-agent.ps1" (
    echo [INFO] Curl failed. Trying PowerShell engine...
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; [System.Net.ServicePointManager]::CheckCertificateRevocationList = $false; (New-Object System.Net.WebClient).DownloadFile('%AGENT_URL%', 'monitorhub-agent.ps1')"
)

if exist "monitorhub-agent.ps1" (
    echo [SUCCESS] Agent Engine downloaded.
    
    :: ── Configuration ────────────────────────────────────────
    echo [INFO] Configuring Agent Environment...
    
    :: Write local configuration for persistence
    echo { "token": "${token}", "url": "${hostUrl}/api/v1/agents/ingest" } > "config.json"
    
    :: Set machine-level env for legacy support
    setx AGENT_TOKEN "${token}" /M >nul
    setx INGEST_URL "${hostUrl}/api/v1/agents/ingest" /M >nul
    
    :: Set for current session
    set "AGENT_TOKEN=${token}"
    set "INGEST_URL=${hostUrl}/api/v1/agents/ingest"

    :: ── Persistence Setup ─────────────────────────────────────
    echo [INFO] Registering System Background Service...
    
    :: Delete old task if exists
    schtasks /delete /tn "MonitorHubAgent" /f >nul 2>&1
    
    :: Create new High-Privilege task (Pass token directly to avoid env latency)
    set "TASK_CMD=powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"%INSTALL_DIR%\\monitorhub-agent.ps1\\" -Token \\"${token}\\" -Url \\"${hostUrl}/api/v1/agents/ingest\\""
    schtasks /create /tn "MonitorHubAgent" /tr "!TASK_CMD!" /sc onstart /ru SYSTEM /f /rl HIGHEST
    
    :: Start it immediately
    schtasks /run /tn "MonitorHubAgent"
    
    echo ========================================================
    echo  [SUCCESS] MonitorHub Enterprise Agent is ACTIVE!
    echo  Check your dashboard in 10 seconds.
    echo ========================================================
    pause
    exit /b
)

echo [ERROR] Could not download agent engine. Please check your internet connection and firewall.
pause`;
        return reply
            .type('application/octet-stream')
            .header('Content-Disposition', 'attachment; filename="setup_monitorhub_windows.bat"')
            .send(script);
    });

    // ────────────────────────────────────────────────────────────────────
    // PUBLIC — Agent Distribution (Go Agent)
    // ────────────────────────────────────────────────────────────────────
    
    fastify.get('/manifest/:version', {
        config: { rateLimit: { max: 100, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const { version } = request.params;
        const agentToken = request.headers['x-agent-token'];
        
        try {
            fastify.log.info({ version, agentToken: !!agentToken }, 'Manifest request received');
            let query = 'SELECT * FROM agent_releases WHERE is_stable = true ';
            let params = [];
            
            if (version === 'latest') {
                query += 'ORDER BY created_at DESC LIMIT 1';
            } else {
                query += 'AND version = $1 LIMIT 1';
                params.push(version);
            }

            const releaseRes = await fastify.db.query(query, params);
            if (releaseRes.rows.length === 0) return reply.status(404).send({ error: 'Release not found' });

            const release = releaseRes.rows[0];
            
            // ── Rollout Control Logic ─────────────────────────────────────────
            // If it's a 'latest' request and the release has a rollout percentage
            if (version === 'latest' && release.rollout_percentage < 100) {
                // Simple deterministic hash-based rollout (sticky per agent)
                const agentToken = request.headers['x-agent-token'];
                if (agentToken) {
                    const hash = crypto.createHash('md5').update(agentToken).digest('hex');
                    const bucket = parseInt(hash.substring(0, 2), 16) % 100;
                    if (bucket >= release.rollout_percentage) {
                        // Not in rollout group — find previous stable release
                        const prevRes = await fastify.db.query(
                            'SELECT * FROM agent_releases WHERE is_stable = true AND created_at < $1 ORDER BY created_at DESC LIMIT 1',
                            [release.created_at]
                        );
                        if (prevRes.rows.length > 0) {
                            return reply.send(await buildManifest(fastify, prevRes.rows[0]));
                        }
                    }
                }
            }

            const manifest = await buildManifest(fastify, release);
            
            // ── CDN / Caching Headers ─────────────────────────────────────────
            reply.header('Cache-Control', 'public, max-age=600'); // 10 mins
            reply.header('ETag', `"${release.version}-${release.id}"`);

            return reply.send(manifest);
        } catch (err) {
            fastify.log.error(err, 'Manifest error');
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    // Alias for /manifest/latest
    fastify.get('/manifest', (req, res) => res.redirect('/api/v1/agents/manifest/latest'));

    async function buildManifest(fastify, release) {
        const binaryRes = await fastify.db.query('SELECT os, arch, sha256 FROM agent_binaries WHERE release_id = $1', [release.id]);
        const platforms = {};
        binaryRes.rows.forEach(b => {
            platforms[`${b.os}-${b.arch}`] = {
                url: `/api/v1/agents/bin/${b.os}/${b.arch}?v=${release.version}`,
                sha256: b.sha256
            };
        });
        return {
            version: release.version,
            stable: release.is_stable,
            release_notes: release.release_notes,
            rollout: {
                enabled: release.rollout_percentage < 100,
                percentage: release.rollout_percentage || 100
            },
            platforms
        };
    }

    // 2. Binary Download
    fastify.get('/bin/:os/:arch', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const { os, arch } = request.params;
        
        try {
            const res = await fastify.db.query(`
                SELECT b.file_path, b.id, b.sha256, r.version 
                FROM agent_binaries b
                JOIN agent_releases r ON b.release_id = r.id
                WHERE r.is_stable = true AND b.os = $1 AND b.arch = $2
                ORDER BY r.created_at DESC LIMIT 1
            `, [os, arch]);

            if (res.rows.length === 0) {
                fastify.log.warn({ os, arch }, 'Binary download failed - Not found');
                return reply.status(404).send({ error: 'Binary not found' });
            }

            const binary = res.rows[0];
            fastify.log.info({ os, arch, version: binary.version, sha256: binary.sha256 }, 'Serving agent binary');
            
            // ── CDN Headers ───────────────────────────────────────────────────
            reply.header('Cache-Control', 'public, max-age=86400'); // 24 hours for immutable binaries
            reply.header('Content-Disposition', `attachment; filename="monitorhub-agent-${os}-${arch}"`);
            
            // Increment download count (async)
            fastify.db.query('UPDATE agent_binaries SET download_count = download_count + 1 WHERE id = $1', [binary.id]).catch(() => {});

            // Log download to audit (optional)
            fastify.log.info(`[AgentDistribution] Download: ${os}/${arch}`);

            if (binary.file_path.startsWith('http')) {
                // Production: Redirect to S3/CDN
                return reply.redirect(binary.file_path);
            } else {
                // Development/Local: Stream from disk
                const absPath = path.resolve(__dirname, '../../../', binary.file_path);
                if (!fs.existsSync(absPath)) {
                    return reply.status(404).send({ error: 'Binary file missing on server' });
                }
                const stream = fs.createReadStream(absPath);
                return reply.type('application/octet-stream').send(stream);
            }
        } catch (err) {
            fastify.log.error(err, 'Binary download error');
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    fastify.get('/install_linux.sh', async (request, reply) => {
        const { token, host } = request.query;
        if (!token) return reply.status(400).send('Agent token is required');

        const hostUrl = host || process.env.PUBLIC_API_URL || 'https://api.monitorhubs.com';
        
        const script = `#!/bin/bash
set -e
echo "========================================="
echo " MonitorHub Enterprise Agent Setup (Linux Native)"
echo "========================================="

echo "[INFO] Downloading Native Python Agent..."
curl -s -f -L -o /usr/local/bin/monitorhub-agent "${hostUrl}/api/v1/agents/scripts/linux"
chmod +x /usr/local/bin/monitorhub-agent

mkdir -p /etc/monitorhub-agent
echo "AGENT_TOKEN=${token}" > /etc/monitorhub-agent/.env
echo "INGEST_URL=${hostUrl}/api/v1/agents/ingest" >> /etc/monitorhub-agent/.env

# Create Systemd Service
echo "[INFO] Creating systemd service..."
cat <<EOF > /etc/systemd/system/monitorhub-agent.service
[Unit]
Description=MonitorHub Native Agent
After=network.target

[Service]
EnvironmentFile=/etc/monitorhub-agent/.env
ExecStart=/usr/bin/python3 /usr/local/bin/monitorhub-agent
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable monitorhub-agent
systemctl restart monitorhub-agent

echo "[SUCCESS] Native MonitorHub Agent is now active!"
`;
        return reply
            .type('application/octet-stream')
            .header('Content-Disposition', 'attachment; filename="setup_monitorhub_linux.sh"')
            .send(script);
    });

    // ────────────────────────────────────────────────────────────────────
    // Serve the actual Native Script Files
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/scripts/windows', async (request, reply) => {
        const scriptPath = path.resolve(__dirname, './bin/uptimebuddy-agent.ps1');
        if (!fs.existsSync(scriptPath)) return reply.status(404).send('Agent script not found');
        const content = await fs.promises.readFile(scriptPath, 'utf-8');
        return reply.type('text/plain').send(content);
    });

    fastify.get('/scripts/linux', async (request, reply) => {
        const scriptPath = path.resolve(__dirname, './bin/uptimebuddy-agent.py');
        if (!fs.existsSync(scriptPath)) return reply.status(404).send('Agent script not found');
        const content = await fs.promises.readFile(scriptPath, 'utf-8');
        return reply.type('text/plain').send(content);
    });

    // ────────────────────────────────────────────────────────────────────
    // PROFESSIONAL MSI DISTRIBUTION
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/install_windows.msi', async (request, reply) => {
        const { token } = request.query;
        
        try {
            // Priority 1: Check Database (Harden for all column naming versions)
            const res = await fastify.db.query(`
                SELECT b.file_path 
                FROM agent_binaries b
                JOIN agent_releases r ON b.release_id = r.id
                WHERE (b.platform = 'windows' OR b.os = 'windows') 
                  AND (b.architecture = 'amd64' OR b.arch = 'amd64')
                  AND r.is_stable = true
                ORDER BY r.created_at DESC LIMIT 1
            `);

            if (res.rows.length > 0 && res.rows[0].file_path) {
                return reply.redirect(res.rows[0].file_path);
            }

            // Priority 2: Check Local Disk (Legacy/Dev)
            const msiPath = path.resolve(__dirname, '../../../MonitorHubAgent.msi');
            if (fs.existsSync(msiPath)) {
                return reply.download('MonitorHubAgent.msi');
            }

            // Priority 3: Final Fallback to Professional .bat
            const hostUrl = process.env.PUBLIC_API_URL || 'https://api.monitorhubs.com';
            return reply.redirect(`${hostUrl}/api/v1/agents/install_windows.bat?token=${token}`);
        } catch (err) {
            // On error, still try to fallback to .bat so the installation doesn't break
            const hostUrl = process.env.PUBLIC_API_URL || 'https://api.monitorhubs.com';
            return reply.redirect(`${hostUrl}/api/v1/agents/install_windows.bat?token=${token}`);
        }
    });


    // ────────────────────────────────────────────────────────────────────
    // PROTECTED — Dashboard / Management Routes (Auth required)
    // ────────────────────────────────────────────────────────────────────
    fastify.register(async (authScope) => {
        authScope.addHook('onRequest', requireAuth);

        // List all servers for user (With Live Metrics)
        authScope.get('/', async (request, reply) => {
            const userId = request.user.id;
            try {
                const res = await fastify.db.query(`
                    SELECT a.*, 
                           m.cpu_percent as cpu_usage, 
                           m.ram_percent, 
                           m.recorded_at as metric_last_seen,
                           m.process_count,
                           m.uptime_seconds
                    FROM agents a
                    LEFT JOIN LATERAL (
                        SELECT cpu_percent, ram_percent, recorded_at, process_count, uptime_seconds
                        FROM agent_metrics
                        WHERE agent_id = a.id
                        ORDER BY recorded_at DESC
                        LIMIT 1
                    ) m ON true
                    WHERE a.user_id = $1
                    ORDER BY a.created_at DESC`, 
                    [userId]
                );

                const mapped = res.rows.map(agent => ({
                    ...agent,
                    status: getDynamicAgentStatus(agent)
                }));

                return reply.send(mapped);
            } catch (err) {
                fastify.log.error(err, 'listAgents error');
                return reply.status(500).send({ error: 'Failed to fetch servers' });
            }
        });

        // Get metrics for a single server
        authScope.get('/:id/metrics', async (request, reply) => {
            const userId   = request.user.id;
            const { id }   = request.params;
            const duration = request.query.duration;

            try {
                const verify = await fastify.db.query(
                    'SELECT id, name, status, agent_token, last_seen FROM agents WHERE id = $1 AND user_id = $2',
                    [id, userId]
                );
                if (verify.rows.length === 0) return reply.code(404).send({ error: 'Server not found' });

                let queryText;
                let queryParams = [id];

                if (duration === '24H' || duration === '12H') {
                    const interval = duration === '24H' ? '24 hours' : '12 hours';
                    const bucketSize = duration === '24H' ? '15 minutes' : '5 minutes';
                    
                    queryText = `
                        SELECT TO_CHAR(bucket, 'HH24:MI') AS time,
                               AVG(cpu_percent)::numeric(5,2)  AS cpu,
                               AVG(ram_mb)::int                AS memory,
                               MAX(ram_total_mb)::int          AS memory_total,
                               AVG(disk_percent)::numeric(5,2) AS disk,
                               AVG(net_rx_mb)::numeric(8,3)    AS net_rx,
                               AVG(net_tx_mb)::numeric(8,3)    AS net_tx,
                               MAX(uptime_seconds)::bigint     AS uptime_seconds,
                               AVG(process_count)::int         AS process_count
                        FROM (
                            SELECT 
                                date_trunc('minute', recorded_at) - (CAST(EXTRACT(minute FROM recorded_at) AS integer) % ${parseInt(bucketSize)}) * interval '1 minute' as bucket,
                                *
                            FROM agent_metrics 
                            WHERE agent_id = $1 AND recorded_at >= NOW() - INTERVAL '${interval}'
                        ) AS bucketed
                        GROUP BY bucket
                        ORDER BY bucket ASC`;
                } else {
                    // Default: last 60 raw data points (~30 min at 30s intervals)
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
                               cpu_percent AS cpu, ram_mb AS memory, ram_total_mb AS memory_total,
                               ram_percent, disk_percent AS disk, net_rx_mb AS net_rx, net_tx_mb AS net_tx,
                               uptime_seconds, process_count
                        FROM agent_metrics WHERE agent_id = $1
                        ORDER BY recorded_at DESC LIMIT 60`;
                }

                const res          = await fastify.db.query(queryText, queryParams);
                const finalMetrics = duration ? res.rows : res.rows.reverse();

                return reply.send({ 
                    server: { ...verify.rows[0], status: getDynamicAgentStatus(verify.rows[0]) }, 
                    metrics: finalMetrics 
                });
            } catch (err) {
                fastify.log.error(err, 'getAgentMetrics error');
                return reply.status(500).send({ error: 'Failed to fetch metrics' });
            }
        });

        // Generate a new server token and pre-register it
        authScope.post('/generate-token', async (request, reply) => {
            const userId     = request.user.id;
            const { name, server_group } = request.body || {};
            const usageService = require('../../core/auth/usageService');

            if (!name || !name.trim()) {
                return reply.status(400).send({ error: 'Server name is required' });
            }

            // 1. Quota Enforcement [Phase C - Hard Enforcement]
            try {
                await usageService.checkLimit(fastify.db, request.user, 'server');
            } catch (limitErr) {
                fastify.log.info(`Blocking server token for User ${userId}: ${limitErr.message}`);
                return reply.code(403).send({ 
                    error: limitErr.message,
                    limitReached: true,
                    upgradeRequired: true,
                    billingUrl: '/dashboard/billing'
                });
            }

            try {
                const rawToken = crypto.randomBytes(24).toString('hex');
                const token    = `ub_${rawToken}`;

                await fastify.db.query(
                    "INSERT INTO agents (user_id, name, server_group, agent_token, status) VALUES ($1, $2, $3, $4, 'pending')",
                    [userId, name.trim(), (server_group || 'Ungrouped').trim(), token]
                );

                return reply.send({ token });
            } catch (err) {
                fastify.log.error(err, 'generateToken error');
                return reply.status(500).send({ error: 'Failed to generate token' });
            }
        });

        // Update server name / group
        authScope.put('/:id', async (request, reply) => {
            const userId = request.user.id;
            const { id } = request.params;
            const { name, server_group } = request.body || {};

            if (!name && server_group === undefined) {
                return reply.code(400).send({ error: 'Nothing to update' });
            }

            try {
                const res = await fastify.db.query(
                    `UPDATE agents SET
                       name         = COALESCE($1, name),
                       server_group = COALESCE($2, server_group)
                     WHERE id = $3 AND user_id = $4 RETURNING id, name, server_group, status`,
                    [name || null, server_group !== undefined ? server_group : null, id, userId]
                );
                if (res.rows.length === 0) return reply.code(404).send({ error: 'Server not found' });
                
                // Professional Audit Log
                const teamRes = await fastify.db.query('SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1', [userId]);
                if (teamRes.rows.length > 0) {
                    await auditService.log(userId, teamRes.rows[0].team_id, 'server_updated', { name: res.rows[0].name, group: server_group });
                }

                return reply.send(res.rows[0]);
            } catch (err) {
                fastify.log.error(err, 'updateAgent error');
                return reply.status(500).send({ error: 'Failed to update server' });
            }
        });

        // Delete server + cascade metrics
        authScope.delete('/:id', async (request, reply) => {
            const userId = request.user.id;
            const { id } = request.params;

            try {
                // Ownership check
                const verify = await fastify.db.query(
                    'SELECT id, name FROM agents WHERE id = $1 AND user_id = $2', [id, userId]
                );
                if (verify.rows.length === 0) return reply.code(404).send({ error: 'Server not found' });

                const serverName = verify.rows[0].name;

                // agent_metrics has ON DELETE CASCADE — but we also delete explicitly to be safe
                await fastify.db.query('DELETE FROM agent_metrics WHERE agent_id = $1', [id]);
                await fastify.db.query('DELETE FROM agents WHERE id = $1', [id]);

                // Professional Audit Log
                const teamRes = await fastify.db.query('SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1', [userId]);
                if (teamRes.rows.length > 0) {
                    await auditService.log(userId, teamRes.rows[0].team_id, 'server_deleted', { name: serverName, id });
                }

                return reply.send({ success: true });
            } catch (err) {
                fastify.log.error(err, 'deleteAgent error');
                return reply.status(500).send({ error: 'Failed to delete server' });
            }
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // BACKGROUND HEALTH CHECKER (Enterprise Pulse Monitor)
    // ────────────────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            // Find agents that haven't reported in 90 seconds but are still marked as 'up'
            const staleRes = await fastify.db.query(`
                SELECT id, user_id, name FROM agents 
                WHERE status = 'up' 
                AND last_seen < NOW() - INTERVAL '90 seconds'
            `);

            for (const agent of staleRes.rows) {
                // 1. Mark as Down
                await fastify.db.query("UPDATE agents SET status = 'down' WHERE id = $1", [agent.id]);
                
                // 2. Trigger Alert
                await fastify.db.query(
                    'INSERT INTO alert_history (user_id, monitor_id, type, message, severity) VALUES ($1, $2, $3, $4, $5)',
                    [agent.user_id, null, 'server_status', `[${agent.name}] System Offline: No heartbeat detected for 90s.`, 'critical']
                );

                // 3. Log to Audit (Team Scope)
                const teamRes = await fastify.db.query('SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1', [agent.user_id]);
                if (teamRes.rows.length > 0) {
                    await auditService.log(agent.user_id, teamRes.rows[0].team_id, 'server_down', { name: agent.name, id: agent.id });
                }
                
                fastify.log.warn({ agentId: agent.id }, 'Agent marked DOWN due to inactivity');
            }
        } catch (err) {
            fastify.log.error(err, 'Health checker failed');
        }
    }, 60000); // Check every 60 seconds
}

module.exports = agentRoutes;
