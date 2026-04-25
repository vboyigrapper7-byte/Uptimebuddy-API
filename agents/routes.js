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
    // ONE-TIME ACTIVATION ROUTE (Visit once to setup database)
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/internal/seed-distribution', async (request, reply) => {
        try {
            // SELF-HEALING: Add missing columns if they don't exist
            await fastify.db.query(`
                -- Repair agent_releases
                ALTER TABLE agent_releases ADD COLUMN IF NOT EXISTS rollout_percentage integer DEFAULT 100;
                
                -- Repair agent_binaries (os/arch -> platform/architecture)
                ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS platform varchar(50);
                ALTER TABLE agent_binaries ADD COLUMN IF NOT EXISTS architecture varchar(50);
                
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

            const r2Base = 'https://pub-cd0ef10a12e241db85b83f22821052a0.r2.dev/bin/v1.0.0';
            
            // 1. Setup Release
            await fastify.db.query(`
                INSERT INTO agent_releases (version, is_stable, rollout_percentage)
                VALUES ('1.0.0', true, 100)
                ON CONFLICT (version) DO NOTHING;
            `);

            // 2. Setup Windows MSI
            await fastify.db.query(`
                INSERT INTO agent_binaries (release_id, platform, architecture, file_path, sha256)
                VALUES (
                    (SELECT id FROM agent_releases WHERE version = '1.0.0' LIMIT 1),
                    'windows', 'amd64',
                    '${r2Base}/windows-amd64/MonitorHubAgent.msi',
                    'N/A'
                )
                ON CONFLICT (platform, architecture, release_id) DO UPDATE SET file_path = EXCLUDED.file_path;
            `);

            // 3. Setup Linux Agent
            await fastify.db.query(`
                INSERT INTO agent_binaries (release_id, platform, architecture, file_path, sha256)
                VALUES (
                    (SELECT id FROM agent_releases WHERE version = '1.0.0' LIMIT 1),
                    'linux', 'amd64',
                    '${r2Base}/linux-amd64/uptimebuddy-agent.py',
                    'N/A'
                )
                ON CONFLICT (platform, architecture, release_id) DO UPDATE SET file_path = EXCLUDED.file_path;
            `);

            return { success: true, message: "Database REPAIRED and SEEDED with R2 links successfully!" };
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
                const metaChanged      = hostname || os_type || agent_version;

                if (metaChanged || publicIpChanged || privateIpChanged) {
                    await fastify.db.query(`
                        UPDATE agents SET 
                            last_seen = NOW(),
                            status = 'active',
                            agent_type = $6,
                            agent_version = COALESCE($7, agent_version),
                            public_ip = COALESCE($2, public_ip),
                            private_ip = COALESCE($3, private_ip),
                            prev_public_ip = CASE WHEN $2 IS NOT NULL AND $2 != COALESCE(public_ip, '') THEN public_ip ELSE prev_public_ip END,
                            prev_private_ip = CASE WHEN $3 IS NOT NULL AND $3 != COALESCE(private_ip, '') THEN private_ip ELSE prev_private_ip END,
                            ip_changed_at = CASE WHEN ($2 IS NOT NULL AND $2 != COALESCE(public_ip, '')) OR ($3 IS NOT NULL AND $3 != COALESCE(private_ip, '')) THEN NOW() ELSE ip_changed_at END,
                            hostname = COALESCE($4, hostname),
                            os_type = COALESCE($5, os_type)
                        WHERE id = $1`, 
                        [agentId, public_ip || null, private_ip || null, hostname || null, os_type || null, agent_type, agent_version || null]
                    );
                } else {
                    await fastify.db.query("UPDATE agents SET last_seen = NOW(), status = 'active' WHERE id = $1", [agentId]);
                }
            } catch (err) {
                // FINAL FALLBACK: Essential Heartbeat
                await fastify.db.query("UPDATE agents SET last_seen = NOW(), status = 'active', agent_type = $2 WHERE id = $1", [agentId, agent_type]);
            }

            // 4. Check for Updates (Rollout-Aware)
            let update_available = null;
            if (agent_type === 'go' && agent_version) {
                try {
                    const latestRes = await fastify.db.query('SELECT * FROM agent_releases WHERE is_stable = true ORDER BY created_at DESC LIMIT 1');
                    if (latestRes.rows.length > 0) {
                        const latest = latestRes.rows[0];
                        if (latest.version !== agent_version) {
                            // Determine if this specific agent is in the rollout group
                            let inRolloutGroup = true;
                            if (latest.rollout_percentage < 100) {
                                const hash = crypto.createHash('md5').update(agent_token).digest('hex');
                                const bucket = parseInt(hash.substring(0, 2), 16) % 100;
                                inRolloutGroup = (bucket < latest.rollout_percentage);
                            }

                            if (inRolloutGroup) {
                                update_available = latest.version;
                                fastify.log.info({ agentId, agent_version, latest: latest.version }, 'Update signal sent to agent');
                            }
                        }
                    }
                } catch (e) { 
                    fastify.log.error(e, 'Error checking for agent update');
                }
            }

            return reply.send({ success: true, update_available });
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
echo  MonitorHub Enterprise Agent Setup (Windows Native)
echo ========================================================

:: ── Directory Setup ────────────────────────────────────────────────────────
set "INSTALL_DIR=C:\\Program Files\\MonitorHub"
mkdir "%INSTALL_DIR%" 2>nul
cd /d "%INSTALL_DIR%"

:: ── Download Native PowerShell Agent ────────────────────────────────────────
echo [INFO] Downloading Native Pro Agent...
curl.exe --ssl-no-revoke -f -s -L -o "monitorhub-agent.ps1" "${hostUrl}/api/v1/agents/scripts/windows"

if %errorLevel% equ 0 (
    echo [SUCCESS] Native Agent downloaded.
    
    :: Create config
    echo [INFO] Configuring Environment...
    setx AGENT_TOKEN "${token}" /M >nul
    setx INGEST_URL "${hostUrl}/api/v1/agents/ingest" /M >nul

    :: Register as a Scheduled Task (Native Windows way to run in background)
    echo [INFO] Registering System Background Task...
    schtasks /create /tn "MonitorHubAgent" /tr "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"%INSTALL_DIR%\\monitorhub-agent.ps1\\"" /sc onstart /ru SYSTEM /f
    schtasks /run /tn "MonitorHubAgent"
    
    echo ========================================================
    echo  [SUCCESS] Native Enterprise Agent installed!
    echo  Telemetry is now flowing in the background.
    echo ========================================================
    pause
    exit /b
)

:: ── Final Fallback to Node.js (Robust Legacy Path) ──────────────────────────
echo [WARNING] Native Script Agent failed. Attempting Node.js Recovery...
node -v >nul 2>&1
if %errorLevel% equ 0 (
    mkdir "%USERPROFILE%\\monitorhub-agent" 2>nul
    cd /d "%USERPROFILE%\\monitorhub-agent"
    echo AGENT_TOKEN=${token}> .env
    echo INGEST_URL=${hostUrl}/api/v1/agents/ingest>> .env
    call npm init -y >nul
    call npm install axios dotenv systeminformation node-windows --quiet
    curl.exe -s -L -o agent.js "${hostUrl}/api/v1/agents/script"
    curl.exe -s -L -o service.js "${hostUrl}/api/v1/agents/windows-service.js"
    node service.js
    echo [SUCCESS] Legacy Node Agent installed successfully.
) else (
    echo [ERROR] No compatible runtime found.
)
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
        const scriptPath = path.resolve(__dirname, '../../../uptimebuddy-agent.ps1');
        const content = await fs.promises.readFile(scriptPath, 'utf-8');
        return reply.type('text/plain').send(content);
    });

    fastify.get('/scripts/linux', async (request, reply) => {
        const scriptPath = path.resolve(__dirname, '../../../uptimebuddy-agent.py');
        const content = await fs.promises.readFile(scriptPath, 'utf-8');
        return reply.type('text/plain').send(content);
    });

    // ────────────────────────────────────────────────────────────────────
    // PROFESSIONAL MSI DISTRIBUTION
    // ────────────────────────────────────────────────────────────────────
    fastify.get('/install_windows.msi', async (request, reply) => {
        const { token } = request.query;
        
        try {
            // Priority 1: Check Database for Professional R2 URL
            const res = await fastify.db.query(`
                SELECT b.file_path 
                FROM agent_binaries b
                JOIN agent_releases r ON b.release_id = r.id
                WHERE b.platform = 'windows' AND b.architecture = 'amd64' AND r.is_stable = true
                ORDER BY r.created_at DESC LIMIT 1
            `);

            if (res.rows.length > 0) {
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
