require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const pool = require('../core/db/pool');
const { workerRedisConnection } = require('../core/queue/setup');

/**
 * RetentionWorker
 * Periodically purges old metrics to prevent database bloat.
 * Default retention: 7 days
 */
const retentionWorker = new Worker('retention-tasks', async (job) => {
    const days = parseInt(process.env.METRICS_RETENTION_DAYS || '7', 10);
    console.log(`[RetentionWorker] Starting purge for data older than ${days} days...`);

    try {
        // Purge monitor metrics
        const monitorRes = await pool.query(
            "DELETE FROM monitor_metrics WHERE recorded_at < NOW() - INTERVAL '1 day' * $1",
            [days]
        );
        console.log(`[RetentionWorker] Purged ${monitorRes.rowCount} rows from monitor_metrics`);

        // Purge agent metrics
        const agentRes = await pool.query(
            "DELETE FROM agent_metrics WHERE recorded_at < NOW() - INTERVAL '1 day' * $1",
            [days]
        );
        console.log(`[RetentionWorker] Purged ${agentRes.rowCount} rows from agent_metrics`);

        // Purge resolved incidents older than 30 days
        const incidentRes = await pool.query(
            "DELETE FROM incidents WHERE resolved_at < NOW() - INTERVAL '30 days'"
        );
        console.log(`[RetentionWorker] Purged ${incidentRes.rowCount} resolved incidents older than 30 days`);

    } catch (err) {
        console.error('[RetentionWorker] Error during purge:', err.message);
        throw err;
    }
}, {
    connection: workerRedisConnection,
    // Runs once a day if scheduled correctly via a producer
});

console.log('[RetentionWorker] Initialized and waiting for retention-tasks...');

module.exports = retentionWorker;
