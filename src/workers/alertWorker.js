require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const axios      = require('axios');
const pool       = require('../core/db/pool');
const alertService = require('../core/alerting/alertService');
const logger       = require('../core/utils/logger');
const { workerRedisConnection } = require('../core/queue/setup');

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

        if (currentState.step > 0 && minsSinceLast < 5) {
            logger.worker('AlertWorker', monitorId, `Suppressing duplicate escalation (Step ${currentState.step}, ${Math.round(minsSinceLast)}m ago)`);
            return; // Skip if too soon
        }

        // Update state for next step
        await pool.query(
            'UPDATE monitors SET escalation_state = $1 WHERE id = $2',
            [JSON.stringify({ step: currentState.step + 1, last_trigger: now.toISOString() }), monitorId]
        );
    }

    // ── 1. Dispatch System-wide Alerts (Telegram, Email) ───────────────────
    await alertService.dispatch(job.data);

    // ── 2. Dispatch Per-user Webhooks (Slack, Discord) ──────────────────────
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
                // Telegram storage format: bot_token|chat_id
                const [botToken, chatId] = wh.url.split('|');
                if (botToken && chatId) {
                    await alertService.sendTelegram(job.data, botToken, chatId);
                }
                continue; // telegram doesn't need the axios.post below
            } else if (wh.provider === 'email') {
                const emails = wh.url.split(',').map(e => e.trim()).filter(e => e.length > 0);
                for (const email of emails) {
                    await alertService.sendEmail(job.data, email);
                }
                logger.worker('AlertWorker', monitorId, `✓ Email alerts dispatched to ${emails.length} recipients`);
                continue;
            } else if (wh.provider === 'generic') {
                payload = {
                    event: newStatus === 'up' ? 'MONITOR_RECOVERED' : 'MONITOR_DOWN',
                    monitor_id: monitorId,
                    target,
                    status: newStatus,
                    error: errorMessage,
                    timestamp
                };
            }

            if (payload) {
                await axios.post(wh.url, payload, { timeout: 8000 });
                logger.worker('AlertWorker', monitorId, `✓ ${wh.provider} alert dispatched`);
            }
        } catch (err) {
            console.error(`[AlertWorker] Failed to dispatch ${wh.provider} webhook:`, err.message);
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
