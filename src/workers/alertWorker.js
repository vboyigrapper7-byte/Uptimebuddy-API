require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const axios      = require('axios');
const pool       = require('../core/db/pool');
const alertService = require('../core/alerting/alertService');
const { workerRedisConnection } = require('../core/queue/setup');

const alertWorker = new Worker('alert-webhooks', async (job) => {
    const { monitorId, target, previousStatus, newStatus, errorMessage, timestamp } = job.data;

    console.log(`[AlertWorker] Processing alert for monitor ${monitorId} | ${previousStatus} → ${newStatus}`);

    // Fetch monitor owner
    let userId;
    try {
        const dbRes = await pool.query('SELECT user_id FROM monitors WHERE id = $1', [monitorId]);
        if (dbRes.rows.length === 0) {
            console.log(`[AlertWorker] Monitor ${monitorId} not found — skipping`);
            return;
        }
        userId = dbRes.rows[0].user_id;
    } catch (err) {
        console.error('[AlertWorker] Failed to fetch monitor user_id:', err.message);
        throw err;
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
                console.log(`[AlertWorker] ✓ Email alerts dispatched to ${emails.length} recipients for user ${userId}`);
                continue;
            }

            if (payload) {
                await axios.post(wh.url, payload, { timeout: 8000 });
                console.log(`[AlertWorker] ✓ ${wh.provider} alert dispatched for user ${userId}`);
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
    console.log(`[AlertWorker] Job ${job.id} completed`);
});
alertWorker.on('failed', (job, err) => {
    console.error(`[AlertWorker] Job ${job?.id} failed:`, err.message);
});
alertWorker.on('error', (err) => {
    console.error('[AlertWorker] Worker error:', err.message);
});

console.log('[AlertWorker] Listening for alert-webhooks...');
