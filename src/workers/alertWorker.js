require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const axios      = require('axios');
const pool       = require('../core/db/pool');
const alertService = require('../core/alerting/alertService');
const logger       = require('../core/utils/logger');
const { workerRedisConnection } = require('../core/queue/setup');
const ESCALATION_STEP_INTERVAL_MINS = 5;

const alertWorker = new Worker('alert-webhooks', async (job) => {
    const { monitorId, target, previousStatus, newStatus, errorMessage, timestamp } = job.data;

    console.log(`[AlertWorker] Processing alert for monitor ${monitorId} | ${previousStatus} → ${newStatus}`);

    // Fetch monitor details including escalation state and priority
    let monitor;
    try {
        const dbRes = await pool.query(
            'SELECT user_id, priority, escalation_state, status FROM monitors WHERE id = $1',
            [monitorId]
        );
        if (dbRes.rows.length === 0) {
            logger.info(`[AlertWorker] Monitor ${monitorId} not found — skipping`);
            return;
        }
        monitor = dbRes.rows[0];
    } catch (err) {
        logger.error(`[AlertWorker] DB Error: ${err.message}`);
        throw err;
    }

    const { user_id: userId, priority, escalation_state } = monitor;

    // ── 0. Fetch User Settings & Account Email ─────────────────────────────
    let settings, userEmail;
    try {
        const userRes = await pool.query(
            `SELECT u.email, s.emails_enabled, s.webhooks_enabled 
             FROM users u 
             LEFT JOIN alert_settings s ON u.id = s.user_id 
             WHERE u.id = $1`,
            [userId]
        );
        if (userRes.rows.length > 0) {
            userEmail = userRes.rows[0].email;
            settings = userRes.rows[0];
        }
    } catch (err) {
        logger.error(`[AlertWorker] Settings Error: ${err.message}`);
    }

    // Default to true if no settings record exists yet
    const emailsEnabled = settings?.emails_enabled !== false;
    const webhooksEnabled = settings?.webhooks_enabled !== false;

    // ── 1. Priority Routing Logic ──────────────────────────────────────────
    // If priority is 'low' and it's a 'down' alert, we might want to delay 
    // or group. For now, let's just log it. 
    if (priority === 'low' && newStatus === 'down') {
        logger.worker('AlertWorker', monitorId, 'Low priority monitor — alerts dispatched with standard routing');
    }

    // ── 2. Escalation State Machine ────────────────────────────────────────
    let currentState = escalation_state || { step: 0, last_trigger: null };
    const now = new Date();

    if (newStatus === 'up') {
        // Reset escalation on recovery
        await pool.query(
            'UPDATE monitors SET escalation_state = $1 WHERE id = $2',
            [JSON.stringify({ step: 0, last_trigger: null }), monitorId]
        );
    } else {
        // If down, check if we should trigger next step
        // Step 0: Immediate (Handled below)
        // Step 1: After 5 mins (Simplified logic here)
        const lastTrigger = currentState.last_trigger ? new Date(currentState.last_trigger) : null;
        const minsSinceLast = lastTrigger ? (now - lastTrigger) / 60000 : 999;

        if (currentState.step > 0 && minsSinceLast < ESCALATION_STEP_INTERVAL_MINS) {
            logger.worker('AlertWorker', monitorId, `Suppressing duplicate escalation (Step ${currentState.step}, ${Math.round(minsSinceLast)}m ago)`);
            return; // Skip if too soon
        }

        // Update state for next step
        await pool.query(
            'UPDATE monitors SET escalation_state = $1 WHERE id = $2',
            [JSON.stringify({ step: currentState.step + 1, last_trigger: now.toISOString() }), monitorId]
        );
    }

    // ── 1. Dispatch Account Email Alert (If Enabled) ───────────────────────
    if (emailsEnabled && userEmail) {
        try {
            await alertService.sendEmail(job.data, userEmail);
            console.log(`[AlertWorker] Account email alert dispatched to ${userEmail}`);
            
            await pool.query(
                `INSERT INTO alert_logs (user_id, monitor_id, alert_type, status, provider)
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, monitorId, newStatus, 'success', 'account-email']
            );
        } catch (err) {
            logger.error(`[AlertWorker] Account email failed: ${err.message}`);
            await pool.query(
                `INSERT INTO alert_logs (user_id, monitor_id, alert_type, status, error_message, provider)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [userId, monitorId, newStatus, 'failed', err.message, 'account-email']
            );
        }
    }

    // ── 2. Dispatch System-wide Alerts (Internal Ops) ───────────────────
    await alertService.dispatch(job.data);

    // ── 3. Dispatch Per-user Webhooks (Slack, Discord, Custom) ────────────────
    if (!webhooksEnabled) {
        logger.info(`[AlertWorker] Webhooks disabled for user ${userId} — skipping`);
        return;
    }

    let webhooks;
    try {
        const webhookRes = await pool.query(
            'SELECT provider, url FROM webhooks WHERE user_id = $1',
            [userId]
        );
        webhooks = webhookRes.rows;
    } catch (err) {
        console.error('[AlertWorker] Failed to fetch webhooks:', err.message);
        throw err;
    }

    for (const wh of webhooks) {
        try {
            let payload;
            if (wh.provider === 'slack') {
                payload = alertService.getSlackPayload(job.data);
            } else if (wh.provider === 'discord') {
                payload = alertService.getDiscordPayload(job.data);
            } else if (wh.provider === 'telegram') {
                const [botToken, chatId] = wh.url.split('|');
                if (botToken && chatId) {
                    await alertService.sendTelegram(job.data, botToken, chatId);
                }
                continue;
            } else if (wh.provider === 'email') {
                const emails = wh.url.split(',').map(e => e.trim()).filter(e => e.length > 0);
                for (const email of emails) {
                    await alertService.sendEmail(job.data, email);
                }
                continue;
            } else if (wh.provider === 'generic') {
                payload = {
                    event: newStatus === 'up' ? 'MONITOR_RECOVERED' : (newStatus === 'warning' ? 'MONITOR_DEGRADED' : 'MONITOR_DOWN'),
                    monitor_id: monitorId,
                    target,
                    status: newStatus,
                    error: errorMessage,
                    timestamp
                };
            }

            if (payload) {
                // Independent Retry Logic for Webhooks
                let success = false;
                let attempts = 0;
                let lastError = null;
                while (!success && attempts < 3) {
                    try {
                        attempts++;
                        await axios.post(wh.url, payload, { timeout: 8000 });
                        success = true;
                        logger.worker('AlertWorker', monitorId, `✓ ${wh.provider} alert dispatched (Attempt ${attempts})`);
                    } catch (err) {
                        lastError = err.message;
                        if (attempts >= 3) {
                            logger.error(`[AlertWorker] Final failure for ${wh.provider} after ${attempts} attempts: ${err.message}`);
                        } else {
                            await new Promise(r => setTimeout(r, 2000 * attempts)); // Backoff
                        }
                    }
                }

                // Log the alert delivery result
                await pool.query(
                    `INSERT INTO alert_logs (user_id, monitor_id, alert_type, status, error_message, provider)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [userId, monitorId, newStatus, success ? 'success' : 'failed', success ? null : lastError, wh.provider]
                );
            }
        } catch (err) {
            console.error(`[AlertWorker] Unexpected error for ${wh.provider}:`, err.message);
        }
    }
}, {
    connection: workerRedisConnection,
    concurrency: 5,
});

alertWorker.on('completed', (job) => {
    logger.info(`[AlertWorker] Job ${job.id} completed`);
});
alertWorker.on('failed', (job, err) => {
    logger.error(`[AlertWorker] Job ${job?.id} failed: ${err.message}`);
});
alertWorker.on('error', (err) => {
    logger.error(`[AlertWorker] Worker error: ${err.message}`);
});

console.log('[AlertWorker] Listening for alert-webhooks...');
