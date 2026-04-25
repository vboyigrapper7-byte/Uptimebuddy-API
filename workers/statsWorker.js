const pool = require('../core/db/pool');
const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');

/**
 * Precompute monitor statistics (uptime & latency)
 * This prevents heavy subqueries in the monitor list view.
 */
async function computeMonitorStats() {
    console.log('[StatsWorker] Starting statistics precomputation...');
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Calculate 24h uptime and latency for ALL monitors
        const statsRes = await client.query(`
            WITH metrics_24h AS (
                SELECT 
                    monitor_id,
                    status,
                    response_time_ms
                FROM monitor_metrics
                WHERE recorded_at > NOW() - INTERVAL '24 hours'
            )
            SELECT 
                m.id as monitor_id,
                ROUND(CAST(COUNT(met.status) FILTER (WHERE met.status IN ('up', 'warning')) AS NUMERIC) / GREATEST(COUNT(met.status), 1) * 100, 2) as uptime,
                ROUND(AVG(met.response_time_ms)) as latency
            FROM monitors m
            LEFT JOIN metrics_24h met ON m.id = met.monitor_id
            GROUP BY m.id
        `);

        for (const row of statsRes.rows) {
            await client.query(
                `INSERT INTO monitor_stats (monitor_id, uptime_24h, avg_latency_24h, last_updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (monitor_id) DO UPDATE SET
                    uptime_24h = EXCLUDED.uptime_24h,
                    avg_latency_24h = EXCLUDED.avg_latency_24h,
                    last_updated_at = NOW()`,
                [row.monitor_id, row.uptime || 100.00, row.latency || 0]
            );
        }

        await client.query('COMMIT');
        console.log(`[StatsWorker] Successfully updated stats for ${statsRes.rowCount} monitors.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[StatsWorker] Critical failure during stats computation:', err);
    } finally {
        client.release();
    }
}

// ── BullMQ Worker Definition ───────────────────────────────────────────────
const statsWorker = new Worker(
    'stats-tasks',
    async (job) => {
        if (job.name === 'compute-stats') {
            await computeMonitorStats();
        }
    },
    { 
        connection: workerRedisConnection,
        concurrency: 1 
    }
);

statsWorker.on('completed', (job) => console.log(`[StatsWorker] Job ${job.id} completed.`));
statsWorker.on('failed', (job, err) => console.error(`[StatsWorker] Job ${job.id} failed:`, err));

module.exports = { computeMonitorStats, statsWorker };
