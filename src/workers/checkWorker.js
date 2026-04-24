require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker }          = require('bullmq');
const axios               = require('axios');
const tcpp                = require('tcp-ping');
const jp                  = require('jsonpath');
const pool                = require('../core/db/pool');
const planService         = require('../core/billing/planService');
const logger              = require('../core/utils/logger');
const { workerRedisConnection, alertQueue } = require('../core/queue/setup');
const { getSafeAxiosConfig } = require('../core/utils/ssrf');

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
const ALERT_COOLDOWN_MS = 60 * 1000; // 1 minute global cooldown per monitor

/**
 * Enhanced Alert Cooldown
 * Prevents alert spam by ensuring at least 1 minute between ANY two alerts for the same monitor.
 */
async function canSendAlert(monitorId, customCooldownMins) {
    const res = await pool.query(
        'SELECT last_alert_at FROM monitors WHERE id = $1',
        [monitorId]
    );
    if (res.rows.length === 0 || !res.rows[0].last_alert_at) return true;
    
    const cooldownMs = (customCooldownMins || 1) * 60 * 1000;
    const lastAlertAt = new Date(res.rows[0].last_alert_at).getTime();
    return (Date.now() - lastAlertAt) >= cooldownMs;
}

// ── Main job processor ────────────────────────────────────────────────────
const checkWorker = new Worker('monitor-checks', async (job) => {
    const { monitorId } = job.data;

    // Fetch fresh config (target may have changed since job was enqueued)
    const monitorRes = await pool.query(
        `SELECT m.*, u.tier, u.plan_expiry,
                s.on_down, s.on_up, s.on_warning, s.cooldown_mins,
                (SELECT count(*) FROM monitors WHERE user_id = m.user_id) as user_monitor_count
         FROM monitors m
         JOIN users u ON m.user_id = u.id
         LEFT JOIN alert_settings s ON m.user_id = s.user_id
         WHERE m.id = $1`,
        [monitorId]
    );

    if (monitorRes.rows.length === 0) {
        logger.info(`[CheckWorker] Monitor ${monitorId} not found — skipping`);
        return;
    }

    const monitor = monitorRes.rows[0];
    const { 
        target, type, keyword, status: prev_status, user_id, method, headers, body, 
        timeout_ms, max_retries, expected_status, threshold_ms, region, assertion_config, 
        tier, plan_expiry, user_monitor_count,
        on_down, on_up, on_warning, cooldown_mins, alerts_enabled
    } = monitor;

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
    let statusCode   = null;

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
                timeout: timeout_ms || 30000,
                validateStatus: null,
                maxRedirects: 5,
                maxContentLength: 5 * 1024 * 1024,
                ...getSafeAxiosConfig() // SSRF Protection
            });
            
            statusCode = res.status;
            responseTime = Date.now() - startTime;
            
            // ── Response Validation (Advanced Assertions) ─────────────────────
            const validation = validateResponse(res, { keyword, assertion_config, expected_status });
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

    // ── Update Metrics & State ──────────────────────────────────────────────
    const recordedAt = new Date();
    const maxAttempts = job.opts.attempts || 1;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

    // 1. Determine "Confirmed" status for alerting
    let confirmedStatus = prev_status;
    if (status === 'up') {
        confirmedStatus = (threshold_ms > 0 && responseTime > threshold_ms) ? 'warning' : 'up';
    } else if (isLastAttempt) {
        confirmedStatus = 'down';
    }

    // 2. Insert Metric (Always)
    await pool.query(
        'INSERT INTO monitor_metrics (monitor_id, recorded_at, response_time_ms, status, status_code, error_message) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
        [monitorId, recordedAt, responseTime, status, statusCode, errorMessage]
    );

    // 3. Handle Retries (Non-blocking)
    if (status === 'down' && !isLastAttempt) {
        // Just update last_checked, but keep status the same so next check can detect transition
        await pool.query('UPDATE monitors SET last_checked = $1 WHERE id = $2', [recordedAt, monitorId]);
        throw new Error(errorMessage || `Check failed (Attempt ${job.attemptsMade + 1}/${maxAttempts})`);
    }

    // 4. Update Confirmed Status and Alert
    const isFirstCheck = prev_status === 'pending';
    const hasStatusChanged = prev_status !== confirmedStatus;
    
    if (hasStatusChanged || isFirstCheck) {
        // ── Smart Alerting Logic ──────────────────────────────────────────
        // 1. Determine if we SHOULD alert based on global settings & toggles
        let shouldAlert = hasStatusChanged && !isFirstCheck && alerts_enabled !== false;

        if (shouldAlert) {
            // Respect user-defined triggers (on_down, on_up, on_warning)
            if (confirmedStatus === 'down' && on_down === false) shouldAlert = false;
            if (confirmedStatus === 'up' && on_up === false) shouldAlert = false;
            if (confirmedStatus === 'warning' && on_warning === false) shouldAlert = false;
        }

        if (shouldAlert) {
            const allowedToAlert = await canSendAlert(monitorId, cooldown_mins);
            if (allowedToAlert) {
                console.log(`[CheckWorker] Dispatching alert: ${prev_status} → ${confirmedStatus} for monitor ${monitorId}`);
                
                await alertQueue.add(
                    `alert-${monitorId}-${Date.now()}`,
                    { 
                        monitorId, 
                        target, 
                        previousStatus: prev_status, 
                        newStatus: confirmedStatus, 
                        errorMessage: confirmedStatus === 'warning' ? `Response threshold exceeded: ${responseTime}ms` : errorMessage, 
                        responseTime,
                        timestamp: recordedAt.toISOString() 
                    },
                    { removeOnComplete: { count: 100 } }
                );

                // Record incident or resolve
                if (confirmedStatus === 'down') {
                    await pool.query(
                        'INSERT INTO incidents (monitor_id, started_at, error_message) VALUES ($1, $2, $3)',
                        [monitorId, recordedAt, errorMessage]
                    );
                } else if (prev_status === 'down') {
                    await pool.query(
                        'UPDATE incidents SET resolved_at = $1 WHERE monitor_id = $2 AND resolved_at IS NULL',
                        [recordedAt, monitorId]
                    );
                }

                // Update DB with confirmed status and record the alert time
                await pool.query(
                    'UPDATE monitors SET status = $1, last_checked = $2, last_alert_at = $3 WHERE id = $4',
                    [confirmedStatus, recordedAt, recordedAt, monitorId]
                );
            } else {
                // Cooldown active — update status but don't alert
                await pool.query('UPDATE monitors SET status = $1, last_checked = $2 WHERE id = $3', [confirmedStatus, recordedAt, monitorId]);
            }
        } else {
            // No alert needed (e.g. first check or alerts disabled), just update status
            await pool.query('UPDATE monitors SET status = $1, last_checked = $2 WHERE id = $3', [confirmedStatus, recordedAt, monitorId]);
        }
    } else {
        // No status change confirmed — just refresh last_checked
        await pool.query('UPDATE monitors SET last_checked = $1 WHERE id = $2', [recordedAt, monitorId]);
    }
}, {
    connection: workerRedisConnection,
    concurrency: parseInt(process.env.CHECK_WORKER_CONCURRENCY || '20', 10),
    limiter: { max: 100, duration: 1000 },
});


function isStatusExpected(status, expectedString) {
    if (!expectedString) return status >= 200 && status < 400;
    
    try {
        const parts = expectedString.split(',').map(p => p.trim());
        for (const part of parts) {
            if (part.includes('-')) {
                const [min, max] = part.split('-').map(Number);
                if (status >= min && status <= max) return true;
            } else {
                if (status === Number(part)) return true;
            }
        }
    } catch (e) {
        return status >= 200 && status < 400;
    }
    return false;
}

// ── Helper: Response Validator (Advanced Assertions) ───────────────────────
function validateResponse(res, config) {
    const { keyword, assertion_config, expected_status } = config;
    const ac = assertion_config || {};

    // 1. Status Code Check
    if (!isStatusExpected(res.status, expected_status)) {
        return { status: 'down', errorMessage: `HTTP ${res.status} (Expected ${expected_status || '200-399'})` };
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
