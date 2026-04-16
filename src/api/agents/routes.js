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
    if (typeof ram_mb        !== 'number' || ram_mb        < 0 || ram_mb        > 4194304) return false; // 4 TB max
    // ram_total_mb is optional (added in agent v2.3+)
    if (metrics.ram_total_mb !== undefined && (typeof metrics.ram_total_mb !== 'number' || metrics.ram_total_mb < 0)) return false;
    return true;
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
                `INSERT INTO agent_metrics (agent_id, recorded_at, cpu_percent, ram_mb, ram_total_mb, disk_percent)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [agentId, recordedAt, metrics.cpu_percent, metrics.ram_mb, metrics.ram_total_mb ?? null, metrics.disk_percent]
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
    // PUBLIC — Installer script generators (token needed to download)
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/install_windows.bat', async (request, reply) => {
        const { token, host } = request.query;
        if (!token) return reply.status(400).send('Agent token is required');

        const hostUrl = host || process.env.PUBLIC_API_URL || 'http://localhost:3001';
        const script = `@echo off
setlocal enabledelayedexpansion

:: ── Elevation Check ────────────────────────────────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Must run this installer as ADMINISTRATOR.
    echo Right-click the .bat file and select 'Run as Administrator'.
    echo.
    pause
    exit /b 1
)

echo Starting Monitor Hub Agent Setup...
echo.

:: ── Directory Setup ────────────────────────────────────────────────────────
mkdir "%USERPROFILE%\\monitorhub-agent" 2>nul
cd /d "%USERPROFILE%\\monitorhub-agent"

:: ── Verify Node.js ─────────────────────────────────────────────────────────
node -v >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Node.js not found. Installing Node.js automatically via winget...
    winget install -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
    if %errorLevel% neq 0 (
        echo [ERROR] Failed to install Node.js automatically.
        echo Please install Node.js manually from https://nodejs.org/
        pause
        exit /b 1
    )
    set "PATH=%PATH%;C:\Program Files\nodejs"
    echo [INFO] Node.js installed successfully.
)

:: ── Dependency Installation ────────────────────────────────────────────────
call npm init -y >nul
echo Installing dependencies (axios, systeminformation, pm2)...
call npm install axios dotenv systeminformation pm2 -g --quiet

:: ── Fetch Agent Script ─────────────────────────────────────────────────────
echo Connecting to platform: ${hostUrl}
curl.exe -f -s -o agent.js "${hostUrl}/api/v1/agents/script"
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Could not connect to Monitor Hub Platform!
    echo Ensure this server can reach ${hostUrl}
    echo.
    pause
    exit /b 1
)

:: ── Environment Setup ──────────────────────────────────────────────────────
echo AGENT_TOKEN=${token}> .env
echo INGEST_URL=${hostUrl}/api/v1/agents/ingest>> .env
echo REPORT_INTERVAL_MS=30000>> .env

:: ── PM2 Process Management (Windows Optimized) ─────────────────────────────
echo Restarting monitoring engine...
call pm2 kill >nul 2>&1
call pm2 start agent.js --name "monitorhub-agent" --restart-delay 5000

echo.
echo =========================================
echo  Agent Configuration Upgraded!
echo  Telemetry: Running via Service (PM2)
echo  Auth Mode: Secure Headers
echo =========================================
echo.
echo To view real-time logs, run: pm2 logs monitorhub-agent
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

        const hostUrl = host || process.env.PUBLIC_API_URL || 'http://localhost:3001';
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
npm install axios dotenv systeminformation
npm install -g pm2
curl -fsSL -o agent.js "${hostUrl}/api/v1/agents/script"
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
                const mapped = res.rows.map(agent => {
                    let agentStatus = agent.status;
                    if (agent.last_seen && agent.status !== 'pending') {
                        const secondsSinceSeen = (now - new Date(agent.last_seen).getTime()) / 1000;
                        agentStatus = secondsSinceSeen < 90 ? 'up' : 'down';
                    }
                    return { ...agent, status: agentStatus };
                });

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
                               AVG(cpu_percent)::numeric(5,2) AS cpu,
                               AVG(ram_mb)::int               AS memory,
                               MAX(ram_total_mb)::int         AS memory_total,
                               AVG(disk_percent)::numeric(5,2) AS disk
                        FROM agent_metrics WHERE agent_id = $1
                        AND recorded_at >= NOW() - INTERVAL '24 hours'
                        GROUP BY TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI')
                        ORDER BY 1 ASC`;
                } else if (duration === '12H') {
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI') AS time,
                               AVG(cpu_percent)::numeric(5,2) AS cpu,
                               AVG(ram_mb)::int               AS memory,
                               MAX(ram_total_mb)::int         AS memory_total,
                               AVG(disk_percent)::numeric(5,2) AS disk
                        FROM agent_metrics WHERE agent_id = $1
                        AND recorded_at >= NOW() - INTERVAL '12 hours'
                        GROUP BY TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI')
                        ORDER BY 1 ASC`;
                } else {
                    // Default: last 60 raw data points (~10 min at 10s intervals)
                    queryText = `
                        SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
                               cpu_percent AS cpu, ram_mb AS memory, ram_total_mb AS memory_total, disk_percent AS disk
                        FROM agent_metrics WHERE agent_id = $1
                        ORDER BY recorded_at DESC LIMIT 60`;
                }

                const res          = await fastify.db.query(queryText, queryParams);
                const finalMetrics = duration ? res.rows : res.rows.reverse();

                return reply.send({ server: verify.rows[0], metrics: finalMetrics });
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
