require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker }          = require('bullmq');
const axios               = require('axios');
const tcpp                = require('tcp-ping');
const jp                  = require('jsonpath');
const pool                = require('../core/db/pool');
const planService         = require('../core/billing/planService');
const logger              = require('../core/utils/logger');
const { workerRedisConnection, alertQueue } = require('../core/queue/setup');

// ── TCP Ping wrapper ──────────────────────────────────────────────────────
const pingPromise = (target, port) =>
    new Promise((resolve) => {
        tcpp.ping({ address: target, port, attempts: 1, timeout: 5000 }, (err, data) => {
            if (err) return resolve({ up: false, error: err.message, time: 0 });
            const result = data.results[0];
            if (result.err) return resolve({ up: false, error: result.err.message, time: 0 });
            resolve({ up: true, time: Math.round(result.time) });
        });
    });

// ── Alert cooldown via DB (avoids alert storms on flapping monitors) ──────
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Smart Alert Cooldown
 * - Always allow recovery (UP) alerts to ensure users know when problems are solved.
 * - Prevents "Alert Storms" by suppressing DOWN alerts if any alert (UP or DOWN) 
 *   was sent in the last 2 minutes for this monitor.
 */
async function shouldSendAlert(monitorId, newStatus) {
    if (newStatus === 'up') return true;

    const res = await pool.query(
        `SELECT id FROM incidents
         WHERE monitor_id = $1
           AND (started_at >= NOW() - INTERVAL '1 minute' OR resolved_at >= NOW() - INTERVAL '1 minute')
         LIMIT 1`,
        [monitorId]
    );
    return res.rows.length === 0;
}

// ── Main job processor ────────────────────────────────────────────────────
const checkWorker = new Worker('monitor-checks', async (job) => {
    const { monitorId } = job.data;

    // Fetch fresh config (target may have changed since job was enqueued)
    const monitorRes = await pool.query(
        `SELECT m.*, u.tier, u.plan_expiry,
                (SELECT count(*) FROM monitors WHERE user_id = m.user_id) as user_monitor_count
         FROM monitors m
         JOIN users u ON m.user_id = u.id
         WHERE m.id = $1`,
        [monitorId]
    );

    if (monitorRes.rows.length === 0) {
        logger.info(`[CheckWorker] Monitor ${monitorId} not found — skipping`);
        return;
    }

    const monitor = monitorRes.rows[0];
    const { target, type, keyword, status: prev_status, user_id, method, headers, body, threshold_ms, region, assertion_config, tier, plan_expiry, user_monitor_count } = monitor;

    // ── 1. Monitor Bypass Guard (Plan Enforcement) ─────────────────────────
    const tierConfig = planService.getEffectiveTier({ tier, plan_expiry });
    const limit = tierConfig.limits.uptime || 5;

    if (user_monitor_count > limit) {
        // Find which monitors are "In-Budget" (simplistic: oldest ones)
        const budgetRes = await pool.query(
            'SELECT id FROM monitors WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2',
            [user_id, limit]
        );
        const allowedIds = budgetRes.rows.map(r => r.id);
        if (!allowedIds.includes(monitorId)) {
            logger.worker('CheckWorker', monitorId, 'Over-limit bypass triggered — skipping monitor execution');
            return;
        }
    }

    const startTime = Date.now();
    let status       = 'down';
    let errorMessage = null;
    let responseTime = 0;

    try {
        // ── HTTP / HTTPS / Keyword Analytics (Unified) ─────────────────
        if (type === 'http' || type === 'https' || type === 'keyword') {
            let parsedHeaders = {};
            if (headers) {
                try { parsedHeaders = typeof headers === 'string' ? JSON.parse(headers) : headers; } catch(e){}
            }
            
            const res = await axios({
                url: target,
                method: method || 'GET',
                headers: { ...parsedHeaders, 'User-Agent': 'MonitorHub-Monitor/2.0' },
                data: body,
                timeout: 30000,
                validateStatus: null,
                maxRedirects: 5,
                maxContentLength: 5 * 1024 * 1024,
            });
            
            responseTime = Date.now() - startTime;
            
            // ── Response Validation (Advanced Assertions) ─────────────────────
            const validation = validateResponse(res, { keyword, assertion_config });
            status = validation.status;
            errorMessage = validation.errorMessage;
        }
        // ── TCP Port / Ping ─────────────────────────────────────────────
        else if (type === 'port' || type === 'ping') {
            let host = target;
            let port = 80;
            if (target.includes(':')) {
                [host, port] = target.split(':');
                port = parseInt(port, 10);
            }
            const pingRes = await pingPromise(host, port);
            responseTime  = pingRes.time;
            if (pingRes.up) {
                status = 'up';
            } else {
                errorMessage = pingRes.error || 'Connection refused';
            }
        }

        // ── Threshold check (Smart Alerts) ─────────────────────────────
        if (status === 'up' && threshold_ms > 0 && responseTime > threshold_ms) {
            console.log(`[CheckWorker] Monitor ${monitorId} exceeded threshold: ${responseTime}ms > ${threshold_ms}ms`);
            // We still consider it 'up' but we can flag it or alert on performance degradation
            // For now, let's treat "Threshold exceeded" as a secondary alert trigger if the user wants
        }
    } catch (err) {
        responseTime  = Date.now() - startTime;
        errorMessage  = err.message;
    }

    console.log(`[CheckWorker][${region}] Monitor ${monitorId} → ${status} (${responseTime}ms)`);

    // ── Insert metric ────────────────────────────────────────────────────
    const recordedAt = new Date();
    await pool.query(
        'INSERT INTO monitor_metrics (monitor_id, recorded_at, response_time_ms, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [monitorId, recordedAt, responseTime, status]
    );

    // ── Update monitor current status ────────────────────────────────────
    await pool.query('UPDATE monitors SET status = $1 WHERE id = $2', [status, monitorId]);

    // ── Edge detection — only alert on status CHANGE, with confirmation ──────
    if (prev_status && prev_status !== 'pending' && prev_status !== status) {
        console.log(`[CheckWorker] Status change: ${prev_status} → ${status} for monitor ${monitorId}`);

        // If status went down, verify it at least 2 more times to confirm a "Real Outage"
        let finalStatus = status;
        if (status === 'down') {
            console.log(`[CheckWorker] Down detected — initiating verification pass for monitor ${monitorId}`);
            let failures = 1;
            for (let i = 0; i < 2; i++) {
                // Wait 2 seconds between verification checks
                await new Promise(r => setTimeout(r, 2000));
                const verifyRes = await performCheck(type, target, keyword, method, headers, body);
                if (verifyRes.status === 'down') {
                    failures++;
                } else {
                    finalStatus = 'up'; // Recovered during verification
                    break;
                }
            }
            // Only confirm outage if ALL checks (initial + 2 verifications) failed
            if (failures < 3) {
                console.log(`[CheckWorker] Monitor ${monitorId} recovered during verification (${failures}/3 failures) — not alerting`);
                finalStatus = 'up';
            }
        }

        if (prev_status !== finalStatus) {
            const canAlert = await shouldSendAlert(monitorId, finalStatus);
            if (canAlert) {
                await alertQueue.add(
                    `alert-${monitorId}-${Date.now()}`,
                    { 
                        monitorId, 
                        target, 
                        previousStatus: prev_status, 
                        newStatus: finalStatus, 
                        errorMessage, 
                        responseTime,
                        threshold_ms,
                        region,
                        timestamp: recordedAt.toISOString() 
                    },
                    { removeOnComplete: { count: 100 }, removeOnFail: { count: 50 } }
                );

                // Record incident in DB for history view
                if (finalStatus === 'down') {
                    await pool.query(
                        'INSERT INTO incidents (monitor_id, started_at, error_message) VALUES ($1, $2, $3)',
                        [monitorId, recordedAt, errorMessage]
                    );
                } else if (finalStatus === 'up') {
                    // Resolve the most recent open incident for this monitor
                    await pool.query(
                        `UPDATE incidents SET resolved_at = $1
                         WHERE monitor_id = $2 AND resolved_at IS NULL
                         ORDER BY started_at DESC
                         LIMIT 1`,
                        [recordedAt, monitorId]
                    );
                }
            }
            // Update final status in DB
            await pool.query('UPDATE monitors SET status = $1 WHERE id = $2', [finalStatus, monitorId]);
        }
    }
}, {
    connection: workerRedisConnection,
    concurrency: parseInt(process.env.CHECK_WORKER_CONCURRENCY || '20', 10),
    limiter: { max: 100, duration: 1000 },
});

// Helper for check logic decomposition
async function performCheck(type, target, keyword, method, headers, body) {
    const startTime = Date.now();
    try {
        if (type === 'http' || type === 'https' || type === 'keyword') {
            let parsedHeaders = {};
            if (headers) {
                try { parsedHeaders = typeof headers === 'string' ? JSON.parse(headers) : headers; } catch(e){}
            }
            const res = await axios({
                url: target,
                method: method || 'GET',
                headers: { ...parsedHeaders, 'User-Agent': 'MonitorHub-Monitor/2.0' },
                data: body,
                timeout: 30000,
                validateStatus: null
            });
            
            const isStatusOk = res.status >= 200 && res.status < 400;
            if (isStatusOk) {
                if (keyword) {
                    const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    return { status: bodyText.includes(keyword) ? 'up' : 'down', time: Date.now() - startTime };
                }
                return { status: 'up', time: Date.now() - startTime };
            }
            return { status: 'down', time: Date.now() - startTime };
        }
        if (type === 'port' || type === 'ping') {
            let [host, port] = target.includes(':') ? target.split(':') : [target, 80];
            const pingRes = await pingPromise(host, parseInt(port, 10));
            return { status: pingRes.up ? 'up' : 'down', time: pingRes.time };
        }
    } catch {
        return { status: 'down', time: Date.now() - startTime };
    }
    return { status: 'down', time: 0 };
}

// ── Helper: Response Validator (Advanced Assertions) ───────────────────────
function validateResponse(res, config) {
    const { keyword, assertion_config } = config;
    const ac = assertion_config || {};

    // 1. Status Code Check
    const minStatus = ac.min_status || 200;
    const maxStatus = ac.max_status || 399;
    if (res.status < minStatus || res.status > maxStatus) {
        return { status: 'down', errorMessage: `HTTP ${res.status} (Expected ${minStatus}-${maxStatus})` };
    }

    // 2. Keyword Check (Legacy support)
    if (keyword) {
        const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        if (!bodyText.includes(keyword)) {
            return { status: 'down', errorMessage: `Keyword "${keyword}" not found` };
        }
    }

    // 3. JSON Path Check
    if (ac.json_path && ac.json_value !== undefined) {
        try {
            const matches = jp.query(res.data, ac.json_path);
            if (matches.length === 0 || String(matches[0]) !== String(ac.json_value)) {
                return { status: 'down', errorMessage: `JSONPath "${ac.json_path}" mismatch: got ${matches[0]}` };
            }
        } catch (e) {
            return { status: 'down', errorMessage: `JSONPath Query Error: ${e.message}` };
        }
    }

    // 4. Regex Check
    if (ac.regex_pattern) {
        try {
            const regex = new RegExp(ac.regex_pattern);
            const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            if (!regex.test(bodyText)) {
                return { status: 'down', errorMessage: `Regex pattern mismatch` };
            }
        } catch (e) {
            return { status: 'down', errorMessage: `Invalid Regex Pattern: ${e.message}` };
        }
    }

    return { status: 'up', errorMessage: null };
}

checkWorker.on('completed', (job) => {
    logger.info(`[CheckWorker] Job ${job.id} completed`);
});
checkWorker.on('failed', (job, err) => {
    logger.error(`[CheckWorker] Job ${job?.id} failed: ${err.message}`);
});
checkWorker.on('error', (err) => {
    logger.error(`[CheckWorker] Worker error: ${err.message}`);
});

console.log('[CheckWorker] Listening for monitor-checks...');
