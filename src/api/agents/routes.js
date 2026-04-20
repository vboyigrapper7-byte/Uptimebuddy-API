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
            const agentResult = await fastify.db.query(
                'SELECT id FROM agents WHERE agent_token = $1',
                [agent_token]
            );
            if (agentResult.rows.length === 0) {
                return reply.status(401).send({ error: 'Invalid agent token' });
            }

            const agentId     = agentResult.rows[0].id;
            const recordedAt  = new Date(); // Always use server time — never trust client timestamp

            await fastify.db.query(
                `INSERT INTO agent_metrics
                 (agent_id, recorded_at, cpu_percent, ram_mb, ram_total_mb, disk_percent, net_rx_mb, net_tx_mb, uptime_seconds, process_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT DO NOTHING`,
                [
                    agentId, recordedAt,
                    metrics.cpu_percent, metrics.ram_mb, metrics.ram_total_mb ?? null,
                    metrics.disk_percent,
                    metrics.net_rx_mb ?? null, metrics.net_tx_mb ?? null,
                    metrics.uptime_seconds ?? null, metrics.process_count ?? null
                ]
            );

            await fastify.db.query(
                "UPDATE agents SET last_seen = NOW(), status = 'active' WHERE id = $1",
                [agentId]
            );

            return reply.send({ success: true });
        } catch (err) {
            fastify.log.error(err, 'Agent ingest error');
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

echo Requesting Administrative Privileges...
echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\\getadmin.vbs"
echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\\getadmin.vbs"
cscript //nologo "%temp%\\getadmin.vbs"
del "%temp%\\getadmin.vbs"
exit /b

:elevated
echo Starting Monitor Hub Agent Setup...
echo.

:: ── Directory Setup ────────────────────────────────────────────────────────
mkdir "%USERPROFILE%\\monitorhub-agent" 2>nul
cd /d "%USERPROFILE%\\monitorhub-agent"

:: ── Verify Node.js ─────────────────────────────────────────────────────────
node -v >nul 2>&1
if %errorLevel% equ 0 goto :node_installed

echo [INFO] Node.js not found. Installing Node.js automatically...
winget -v >nul 2>&1
if %errorLevel% neq 0 goto :msi_install

echo [INFO] Using winget...
winget install -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
goto :refresh_path

:msi_install
echo [INFO] Winget not found. Downloading standalone MSI installer...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-x64.msi' -OutFile '%temp%\\nodejs.msi'"
echo [INFO] Installing Node.js ^(this may take 1-2 minutes^)...
msiexec.exe /i "%temp%\\nodejs.msi" /qn /norestart
del "%temp%\\nodejs.msi"

:refresh_path
echo [INFO] Refreshing environment PATH...
for /f "skip=2 tokens=3*" %%A in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v "Path" 2^>nul') do set "MACHINE_PATH=%%A %%B"
for /f "skip=2 tokens=3*" %%A in ('reg query "HKCU\\Environment" /v "Path" 2^>nul') do set "USER_PATH=%%A %%B"

if not defined MACHINE_PATH goto :fallback_path
if not defined USER_PATH (
    set "PATH=!MACHINE_PATH!"
) else (
    set "PATH=!MACHINE_PATH!;!USER_PATH!"
)
goto :verify_node

:fallback_path
set "PATH=%PATH%;C:\\Program Files\\nodejs"

:verify_node
node -v >nul 2>&1
if %errorLevel% equ 0 goto :node_installed
echo [ERROR] Node.js could not be detected after install.
echo Please restart this script, or install Node.js manually from https://nodejs.org/
pause
exit /b 1

:node_installed
echo [INFO] Node.js installed and detected successfully.

:: ── Dependency Installation ────────────────────────────────────────────────
call npm init -y >nul
echo Installing local dependencies (axios, dotenv, systeminformation, node-windows)...
call npm install axios dotenv systeminformation node-windows --quiet

:: ── Fetch Agent Script & Service Installer ─────────────────────────────────
echo Connecting to platform: ${hostUrl}
echo (This may take up to 60 seconds if the server is waking from sleep...)
curl.exe --retry 10 --retry-delay 5 --retry-all-errors --connect-timeout 30 --max-time 120 -o agent.js "${hostUrl}/api/v1/agents/script"
curl.exe --retry 10 --retry-delay 5 --retry-all-errors --connect-timeout 30 --max-time 120 -o service.js "${hostUrl}/api/v1/agents/windows-service.js"
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Could not download agent from Monitor Hub Platform!
    echo Ensure this server can reach ${hostUrl}
    echo If using Render free tier, the backend may still be waking up.
    echo Wait 60 seconds and re-run this script.
    echo.
    pause
    exit /b 1
)

:: ── Environment Setup ──────────────────────────────────────────────────────
echo AGENT_TOKEN=${token}> .env
echo INGEST_URL=${hostUrl}/api/v1/agents/ingest>> .env
echo REPORT_INTERVAL_MS=30000>> .env

:: ── Windows Service Management (node-windows) ──────────────────────────────
echo Installing and starting Native Windows Service...
node service.js

echo.
echo ========================================================
echo  Agent Configuration Upgraded!
echo  Telemetry: Running natively as a Windows System Service
echo  Auth Mode: Secure Headers
echo ========================================================
echo.
echo View service status in Windows "Services.msc" (MonitorHubAgent)
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
echo "Starting Monitor Hub Agent Setup..."

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
echo "(This may take up to 60 seconds if the server is waking from sleep...)"
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
                    `SELECT id, name, server_group, agent_token, last_seen, status
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

            if (!name || !name.trim()) {
                return reply.status(400).send({ error: 'Server name is required' });
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
