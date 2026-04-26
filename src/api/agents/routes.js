const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const auditService = require('../../core/auth/auditService');

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
    // ONE-TIME ACTIVATION ROUTE (Visit once to setup database)
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/internal/seed-distribution', async (request, reply) => {
        try {
            // SELF-HEALING: Add missing columns AND Unique Constraints
            await fastify.db.query(`
                -- Repair agent_releases
                ALTER TABLE agent_releases ADD COLUMN IF NOT EXISTS rollout_percentage integer DEFAULT 100;
                
                -- Repair agent_binaries (os/arch -> platform/architecture)
                ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS platform varchar(50);
                ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS architecture varchar(50);
                
                -- DROP NOT NULL from legacy columns (This fixes the error you saw)
                DO $$ 
                BEGIN 
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_binaries' AND column_name='os') THEN
                        ALTER TABLE agent_binaries ALTER COLUMN os DROP NOT NULL;
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_binaries' AND column_name='arch') THEN
                        ALTER TABLE agent_binaries ALTER COLUMN arch DROP NOT NULL;
                    END IF;
                END $$;

                -- ADD UNIQUE CONSTRAINT
                DO $$ 
                BEGIN 
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_platform_arch_release') THEN
                        ALTER TABLE agent_binaries ADD CONSTRAINT unique_platform_arch_release UNIQUE (platform, architecture, release_id);
                    END IF;
                END $$;

                -- Repair agents table
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_ip varchar(45);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_ip varchar(45);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS hostname varchar(255);
                ALTER TABLE agents ADD COLUMN IF NOT EXISTS os_type varchar(50);
                
                -- Repair agent_metrics table
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS ram_total_mb integer;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_total_gb numeric;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS disk_free_gb numeric;
                ALTER TABLE agent_metrics ADD COLUMN IF NOT EXISTS uptime_seconds bigint;
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
        const agent_version = request.headers['x-agent-version'] || request.body?.agent_version;
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
            const hostname = request.body?.hostname;
            const os_type  = request.body?.os_type;
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
            await fastify.db.query(`
                INSERT INTO agent_metrics (
                    agent_id, recorded_at, cpu_percent, ram_mb, ram_percent, disk_percent, 
                    net_rx_mb, net_tx_mb, process_count,
                    ram_total_mb, disk_total_gb, disk_free_gb, uptime_seconds
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    agentId, recordedAt, 
                    metrics.cpu_percent, metrics.ram_mb, metrics.ram_percent, metrics.disk_percent,
                    metrics.net_rx_mb || 0, metrics.net_tx_mb || 0, metrics.process_count || 0,
                    metrics.ram_total_mb, metrics.disk_total_gb, metrics.disk_free_gb, metrics.uptime_seconds
                ]
            );

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
    echo [INFO] Configuring Environment...
    setx AGENT_TOKEN "${token}" /M >nul
    setx INGEST_URL "${hostUrl}/api/v1/agents/ingest" /M >nul
    
    :: Set for current session too
    set "AGENT_TOKEN=${token}"
    set "INGEST_URL=${hostUrl}/api/v1/agents/ingest"

    :: ── Persistence Setup ─────────────────────────────────────
    echo [INFO] Registering System Background Service...
    
    :: Delete old task if exists
    schtasks /delete /tn "MonitorHubAgent" /f >nul 2>&1
    
    :: Create new High-Privilege task (System level, no window)
    schtasks /create /tn "MonitorHubAgent" /tr "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"%INSTALL_DIR%\\monitorhub-agent.ps1\\"" /sc onstart /ru SYSTEM /f /rl HIGHEST
    
    :: Start it immediately
    schtasks /run /tn "MonitorHubAgent"
    
    echo ========================================================
    echo  [SUCCESS] MonitorHub Enterprise Agent is ACTIVE!
    echo  Check your dashboard in 30 seconds.
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

        // Check if an agent has connected (Used by the onboarding wizard)
        authScope.get('/check-token', async (request, reply) => {
            const { token } = request.query;
            const userId = request.user.id;
            
            if (!token) return reply.status(400).send({ error: 'Token is required' });

            try {
                const res = await fastify.db.query(
                    'SELECT id, last_seen FROM agents WHERE agent_token = $1 AND user_id = $2',
                    [token, userId]
                );

                if (res.rows.length === 0) return reply.send({ connected: false });
                
                const agent = res.rows[0];
                return reply.send({ 
                    connected: agent.last_seen !== null,
                    agent_id: agent.id
                });
            } catch (err) {
                return reply.status(500).send({ error: err.message });
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
