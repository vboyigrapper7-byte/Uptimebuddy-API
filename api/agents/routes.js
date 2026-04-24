const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ── SSRF / private‑IP guard ─────────────────────────────────────────────
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;

// ── Metric range guard ───────────────────────────────────────────────────
function validateMetrics(metrics) {
    const { cpu_percent, ram_mb, disk_percent } = metrics;
    if (typeof cpu_percent   !== 'number' || cpu_percent   < 0 || cpu_percent   > 100) return false;
    if (typeof disk_percent  !== 'number' || disk_percent  < 0 || disk_percent  > 100) return false;
    if (typeof ram_mb        !== 'number' || ram_mb        < 0 || ram_mb        > 4194304) return false;
    if (metrics.ram_total_mb  !== undefined && (typeof metrics.ram_total_mb  !== 'number' || metrics.ram_total_mb  < 0)) return false;
    // Add validation for new disk metrics
    if (metrics.disk_total_gb !== undefined && (typeof metrics.disk_total_gb !== 'number')) return false;
    if (metrics.disk_free_gb  !== undefined && (typeof metrics.disk_free_gb  !== 'number')) return false;
    if (metrics.net_rx_mb     !== undefined && (typeof metrics.net_rx_mb     !== 'number' || metrics.net_rx_mb    < 0)) return false;
    if (metrics.net_tx_mb     !== undefined && (typeof metrics.net_tx_mb     !== 'number' || metrics.net_tx_mb    < 0)) return false;
    if (metrics.uptime_seconds !== undefined && (typeof metrics.uptime_seconds !== 'number' || metrics.uptime_seconds < 0)) return false;
    if (metrics.process_count  !== undefined && (typeof metrics.process_count  !== 'number' || metrics.process_count  < 0)) return false;
    return true;
}

// ── Agent dynamic status helper ───────────────────────────────────────────
function getDynamicAgentStatus(agent) {
    if (!agent.last_seen || agent.status === 'pending') return agent.status;
    const now = Date.now();
    const secondsSinceSeen = (now - new Date(agent.last_seen).getTime()) / 1000;
    return secondsSinceSeen < 90 ? 'up' : 'down';
}

const { requireApiKey } = require('../auth/middleware');

async function agentRoutes(fastify, options) {

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
        const { metrics } = request.body || {};

        if (!agent_token || !metrics) {
            return reply.status(400).send({ error: 'agent_token and metrics are required' });
        }

        if (!validateMetrics(metrics)) {
            return reply.status(400).send({ error: 'Invalid metric values' });
        }

        try {
            // 1. Initial Lookup (Resilient to missing IP columns)
            let agentId, existing;
            try {
                const res = await fastify.db.query('SELECT id, public_ip, private_ip FROM agents WHERE agent_token = $1', [agent_token]);
                if (res.rows.length === 0) return reply.status(401).send({ error: 'Invalid agent token' });
                agentId  = res.rows[0].id;
                existing = res.rows[0];
            } catch (err) {
                // FALLBACK: If columns don't exist yet
                const res = await fastify.db.query('SELECT id FROM agents WHERE agent_token = $1', [agent_token]);
                if (res.rows.length === 0) return reply.status(401).send({ error: 'Invalid agent token' });
                agentId  = res.rows[0].id;
                existing = { id: agentId }; // No IP history available
            }

            const recordedAt = new Date();

            // 2. Log Metrics (Resilient to missing columns)
            try {
                await fastify.db.query(
                    `INSERT INTO agent_metrics
                     (agent_id, recorded_at, cpu_percent, ram_mb, ram_total_mb, disk_percent, net_rx_mb, net_tx_mb, uptime_seconds, process_count, disk_total_gb, disk_free_gb)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                     ON CONFLICT DO NOTHING`,
                    [
                        agentId, recordedAt,
                        metrics.cpu_percent, metrics.ram_mb, metrics.ram_total_mb ?? null,
                        metrics.disk_percent,
                        metrics.net_rx_mb ?? null, metrics.net_tx_mb ?? null,
                        metrics.uptime_seconds ?? null, metrics.process_count ?? null,
                        metrics.disk_total_gb ?? null, metrics.disk_free_gb ?? null
                    ]
                );
            } catch (err) {
                // FALLBACK: Basic metrics only
                await fastify.db.query(
                    `INSERT INTO agent_metrics (agent_id, recorded_at, cpu_percent, ram_mb, disk_percent) VALUES ($1, $2, $3, $4, $5)`,
                    [agentId, recordedAt, metrics.cpu_percent, metrics.ram_mb, metrics.disk_percent]
                );
            }

            // 3. Update Status (Resilient to missing SaaS columns)
            const { public_ip, private_ip, hostname, os_type } = request.body || {};
            try {
                const publicIpChanged  = public_ip && public_ip !== (existing.public_ip || '');
                const privateIpChanged = private_ip && private_ip !== (existing.private_ip || '');
                const metaChanged      = hostname || os_type;

                if (publicIpChanged || privateIpChanged || metaChanged) {
                    await fastify.db.query(`
                        UPDATE agents SET 
                            last_seen = NOW(),
                            status = 'active',
                            public_ip = COALESCE($2, public_ip),
                            private_ip = COALESCE($3, private_ip),
                            prev_public_ip = CASE WHEN $2 IS NOT NULL AND $2 != COALESCE(public_ip, '') THEN public_ip ELSE prev_public_ip END,
                            prev_private_ip = CASE WHEN $3 IS NOT NULL AND $3 != COALESCE(private_ip, '') THEN private_ip ELSE prev_private_ip END,
                            ip_changed_at = CASE WHEN ($2 IS NOT NULL AND $2 != COALESCE(public_ip, '')) OR ($3 IS NOT NULL AND $3 != COALESCE(private_ip, '')) THEN NOW() ELSE ip_changed_at END,
                            hostname = COALESCE($4, hostname),
                            os_type = COALESCE($5, os_type)
                        WHERE id = $1`, 
                        [agentId, public_ip || null, private_ip || null, hostname || null, os_type || null]
                    );
                } else {
                    await fastify.db.query("UPDATE agents SET last_seen = NOW(), status = 'active' WHERE id = $1", [agentId]);
                }
            } catch (err) {
                // FINAL FALLBACK: Essential Heartbeat
                await fastify.db.query("UPDATE agents SET last_seen = NOW(), status = 'active' WHERE id = $1", [agentId]);
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

:: ── Elevation Check & Auto-Elevate ───────────────────────────────────────────
net session >nul 2>&1
if %errorLevel% equ 0 goto :elevated

echo [INFO] Requesting Administrative Privileges...
echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\\getadmin.vbs"
echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\\getadmin.vbs"
cscript //nologo "%temp%\\getadmin.vbs"
del "%temp%\\getadmin.vbs"
exit /b

:elevated
echo.
echo ========================================================
echo  Monitor Hub Agent Setup
echo ========================================================
echo [REQUIRED] Node.js is required to run this agent.
echo [OFFICIAL] Download: https://nodejs.org/
echo ========================================================
echo.

:: ── Directory Setup ────────────────────────────────────────────────────────
mkdir "%USERPROFILE%\\monitorhub-agent" 2>nul
cd /d "%USERPROFILE%\\monitorhub-agent"

:: ── Node.js Discovery ───────────────────────────────────────────────────────
node -v >nul 2>&1
if %errorLevel% equ 0 (
    echo [SUCCESS] Node.js is already installed.
    goto :dependencies
)

echo [INFO] Node.js not detected. Starting automatic installation...

:: ── Download Strategy ──────────────────────────────────────────────────────
set "NODE_URL=https://nodejs.org/dist/v20.12.2/node-v20.12.2-x64.msi"
set "NODE_MSI=%temp%\\nodejs.msi"

echo [INFO] Attempting to download Node.js LTS...
curl.exe -f -s -L -o "%NODE_MSI%" "%NODE_URL%"
if %errorLevel% neq 0 (
    echo [INFO] curl failed, attempting with --ssl-no-revoke fallback...
    curl.exe --ssl-no-revoke -f -s -L -o "%NODE_MSI%" "%NODE_URL%"
)
if %errorLevel% neq 0 (
    echo [INFO] curl fallback failed, attempting bitsadmin...
    bitsadmin /transfer "NodeJSDownload" /priority FOREGROUND "%NODE_URL%" "%NODE_MSI%" >nul
)

if not exist "%NODE_MSI%" (
    echo [ERROR] Failed to download Node.js installer.
    echo [ERROR] Please install Node.js manually from: https://nodejs.org/
    pause
    exit /b 1
)

:: ── Silent Installation ────────────────────────────────────────────────────
echo [INFO] Installing Node.js (this may take 1-2 minutes)...
msiexec.exe /i "%NODE_MSI%" /qn /norestart
if %errorLevel% neq 0 (
    echo [ERROR] msiexec failed with error code %errorLevel%
    pause
    exit /b 1
)
del "%NODE_MSI%"

:: ── Path Refresh (Strictly Registry Based - No PowerShell) ─────────────────
echo [INFO] Refreshing environment variables...
for /f "skip=2 tokens=3*" %%A in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v "Path" 2^>nul') do set "MACHINE_PATH=%%A %%B"
for /f "skip=2 tokens=3*" %%A in ('reg query "HKCU\\Environment" /v "Path" 2^>nul') do set "USER_PATH=%%A %%B"

if defined MACHINE_PATH (
    if defined USER_PATH (
        set "PATH=!MACHINE_PATH!;!USER_PATH!"
    ) else (
        set "PATH=!MACHINE_PATH!"
    )
)

:: ── Final Verification ─────────────────────────────────────────────────────
node -v >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js was installed but is still not detected in PATH.
    echo [ERROR] Please restart this command prompt and run the script again.
    pause
    exit /b 1
)
echo [SUCCESS] Node.js installed and verified.

:dependencies
:: ── Dependency Installation ────────────────────────────────────────────────
echo [INFO] Initializing agent environment...
call npm init -y >nul
echo [INFO] Installing local dependencies...
call npm install axios dotenv systeminformation node-windows --quiet

:: ── Fetch Agent Script & Service Installer ─────────────────────────────────
echo [INFO] Connecting to platform: ${hostUrl}

:: ── Secure Download with Revocation Fallback ──────────────────────────────
:: First attempt: Fast check without retries to detect SSL/Revocation issues immediately
curl.exe --connect-timeout 15 --max-time 30 -o agent.js "${hostUrl}/api/v1/agents/script"
if %errorLevel% neq 0 (
    echo [INFO] Initial connection failed. Retrying with --ssl-no-revoke and wake-up logic...
    curl.exe --ssl-no-revoke --retry 10 --retry-delay 5 --retry-all-errors --connect-timeout 30 --max-time 120 -o agent.js "${hostUrl}/api/v1/agents/script"
)

curl.exe --connect-timeout 15 --max-time 30 -o service.js "${hostUrl}/api/v1/agents/windows-service.js"
if %errorLevel% neq 0 (
    echo [INFO] Initial connection failed. Retrying with --ssl-no-revoke and wake-up logic...
    curl.exe --ssl-no-revoke --retry 10 --retry-delay 5 --retry-all-errors --connect-timeout 30 --max-time 120 -o service.js "${hostUrl}/api/v1/agents/windows-service.js"
)

if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Could not download agent from Monitor Hub Platform!
    echo [INFO] Target: ${hostUrl}
    pause
    exit /b 1
)

:: ── Environment Setup ──────────────────────────────────────────────────────
echo AGENT_TOKEN=${token}> .env
echo INGEST_URL=${hostUrl}/api/v1/agents/ingest>> .env
echo REPORT_INTERVAL_MS=30000>> .env

:: ── Windows Service Management ─────────────────────────────────────────────
echo [INFO] Registering as a Windows System Service...
node service.js

echo.
echo ========================================================
echo  [SUCCESS] Agent Configuration Complete!
echo  Telemetry: Running natively as a Windows System Service
echo ========================================================
echo.
pause`;
        return reply
            .type('application/octet-stream')
            .header('Content-Disposition', 'attachment; filename="setup_monitorhub_windows.bat"')
            .send(script);
    });

    fastify.get('/install_linux.sh', async (request, reply) => {
        const { token, host } = request.query;
        if (!token) return reply.status(400).send('Agent token is required');

        const hostUrl = host || process.env.PUBLIC_API_URL || 'https://api.monitorhubs.com';
        const script = `#!/bin/bash
set -e
echo "========================================="
echo " Starting Monitor Hub Agent Setup..."
echo " Node.js is required for this agent."
echo " Official: https://nodejs.org/"
echo "========================================="

if ! command -v node &> /dev/null; then
    echo "[INFO] Node.js not found. Installing Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    if ! command -v node &> /dev/null; then
        echo "[ERROR] Failed to install Node.js. Please install manually."
        exit 1
    fi
fi

mkdir -p ~/monitorhub-agent
cd ~/monitorhub-agent
npm init -y
echo "Installing local dependencies..."
npm install axios dotenv systeminformation
echo "Installing PM2 globally..."
npm install -g pm2
echo "Connecting to platform: ${hostUrl}"
curl --retry 5 --retry-delay 10 --retry-all-errors --connect-timeout 30 --max-time 120 -o agent.js "${hostUrl}/api/v1/agents/script"
if [ $? -ne 0 ]; then
    echo "[ERROR] Could not download agent from Monitor Hub Platform!"
    echo "Ensure this server can reach ${hostUrl}"
    echo "If using Render free tier, wait 60s and re-run."
    exit 1
fi
echo "AGENT_TOKEN=${token}" > .env
echo "INGEST_URL=${hostUrl}/api/v1/agents/ingest" >> .env
echo "REPORT_INTERVAL_MS=30000" >> .env
pm2 delete monitorhub-agent 2>/dev/null || true
pm2 start agent.js --name monitorhub-agent
pm2 save
pm2 startup | tail -n 1 | bash
echo ""
echo "========================================="
echo " Agent Configuration Upgraded!"
echo " Using secure Header-based Auth."
echo "========================================="`;
        return reply
            .type('application/octet-stream')
            .header('Content-Disposition', 'attachment; filename="setup_monitorhub_linux.sh"')
            .send(script);
    });

    // ────────────────────────────────────────────────────────────────────
    // PROTECTED — Dashboard / Management Routes (Auth required)
    // ────────────────────────────────────────────────────────────────────
    fastify.register(async (authScope) => {
        const { requireAuth } = require('../auth/middleware');
        authScope.addHook('onRequest', requireAuth);

        // List all servers for user
        authScope.get('/', async (request, reply) => {
            const userId = request.user.id;
            try {
                const res = await fastify.db.query(
                    `SELECT id, name, server_group, agent_token, last_seen, status, 
                            public_ip, private_ip, hostname, os_type, ip_changed_at
                     FROM agents WHERE user_id = $1 ORDER BY id DESC`,
                    [userId]
                );

                const now = Date.now();
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

                if (duration === '24H') {
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI') AS time,
                               AVG(cpu_percent)::numeric(5,2)  AS cpu,
                               AVG(ram_mb)::int                AS memory,
                               MAX(ram_total_mb)::int          AS memory_total,
                               AVG(disk_percent)::numeric(5,2) AS disk,
                               AVG(net_rx_mb)::numeric(8,3)    AS net_rx,
                               AVG(net_tx_mb)::numeric(8,3)    AS net_tx,
                               MAX(uptime_seconds)::bigint     AS uptime_seconds,
                               AVG(process_count)::int         AS process_count
                        FROM agent_metrics WHERE agent_id = $1
                        AND recorded_at >= NOW() - INTERVAL '24 hours'
                        GROUP BY TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI')
                        ORDER BY 1 ASC`;
                } else if (duration === '12H') {
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI') AS time,
                               AVG(cpu_percent)::numeric(5,2)  AS cpu,
                               AVG(ram_mb)::int                AS memory,
                               MAX(ram_total_mb)::int          AS memory_total,
                               AVG(disk_percent)::numeric(5,2) AS disk,
                               AVG(net_rx_mb)::numeric(8,3)    AS net_rx,
                               AVG(net_tx_mb)::numeric(8,3)    AS net_tx,
                               MAX(uptime_seconds)::bigint     AS uptime_seconds,
                               AVG(process_count)::int         AS process_count
                        FROM agent_metrics WHERE agent_id = $1
                        AND recorded_at >= NOW() - INTERVAL '12 hours'
                        GROUP BY TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI')
                        ORDER BY 1 ASC`;
                } else {
                    // Default: last 60 raw data points (~10 min at 10s intervals)
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
                               cpu_percent AS cpu, ram_mb AS memory, ram_total_mb AS memory_total,
                               disk_percent AS disk, net_rx_mb AS net_rx, net_tx_mb AS net_tx,
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
                    'SELECT id FROM agents WHERE id = $1 AND user_id = $2', [id, userId]
                );
                if (verify.rows.length === 0) return reply.code(404).send({ error: 'Server not found' });

                // agent_metrics has ON DELETE CASCADE — but we also delete explicitly to be safe
                await fastify.db.query('DELETE FROM agent_metrics WHERE agent_id = $1', [id]);
                await fastify.db.query('DELETE FROM agents WHERE id = $1', [id]);

                return reply.send({ success: true });
            } catch (err) {
                fastify.log.error(err, 'deleteAgent error');
                return reply.status(500).send({ error: 'Failed to delete server' });
            }
        });
    });
}

module.exports = agentRoutes;
