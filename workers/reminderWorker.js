require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const pool = require('../core/db/pool');
const logger = require('../core/utils/logger');
const { workerRedisConnection, alertQueue } = require('../core/queue/setup');

const REMINDER_INTERVAL_MINS = 30;

/**
 * Reminder Worker
 * Periodically checks for monitors that have been DOWN for a while 
 * and sends reminder alerts if they haven't been alerted recently.
 */
const reminderWorker = new Worker('reminder-checks', async (job) => {
    logger.info('[ReminderWorker] Scanning for persistent outages...');

    try {
        // Find monitors that are DOWN and haven't been alerted in their specific reminder interval
        const res = await pool.query(`
            SELECT m.id, m.target, m.status, m.last_alert_at, m.last_checked, m.error_message,
                   COALESCE(s.reminder_mins, 30) as reminder_mins
            FROM monitors m
            LEFT JOIN alert_settings s ON m.user_id = s.user_id
            WHERE m.status = 'down'
              AND m.alerts_enabled = true
              AND (s.reminder_mins IS NULL OR s.reminder_mins > 0)
              AND (m.last_alert_at IS NULL OR m.last_alert_at < NOW() - (COALESCE(s.reminder_mins, 30) || ' minutes')::interval)
            LIMIT 100
        `);

        if (res.rows.length === 0) {
            logger.info('[ReminderWorker] No persistent outages requiring reminders.');
            return;
        }

        for (const monitor of res.rows) {
            logger.worker('ReminderWorker', monitor.id, `Sending reminder for persistent DOWN status`);

            await alertQueue.add(
                `reminder-${monitor.id}-${Date.now()}`,
                {
                    monitorId: monitor.id,
                    target: monitor.target,
                    previousStatus: 'down',
                    newStatus: 'down',
                    errorMessage: `REMINDER: Service is still down. ${monitor.error_message || ''}`,
                    isReminder: true,
                    timestamp: new Date().toISOString()
                }
            );

            // Update last_alert_at to reset the 30-min timer
            await pool.query(
                'UPDATE monitors SET last_alert_at = NOW() WHERE id = $1',
                [monitor.id]
            );
        }
        
        logger.info(`[ReminderWorker] Dispatched ${res.rows.length} reminders.`);
    } catch (err) {
        logger.error(`[ReminderWorker] Scan failed: ${err.message}`);
        throw err;
    }
}, {
    connection: workerRedisConnection,
    concurrency: 1
});

module.exports = reminderWorker;
