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

        // Calculate 24h uptime and latency for ALL monitors and UPSERT in one go
        await client.query(`
            INSERT INTO monitor_stats (monitor_id, uptime_24h, avg_latency_24h, last_updated_at)
            SELECT 
                m.id as monitor_id,
                COALESCE(ROUND(CAST(COUNT(met.status) FILTER (WHERE met.status IN ('up', 'warning')) AS NUMERIC) / GREATEST(COUNT(met.status), 1) * 100, 2), 100.00) as uptime,
                COALESCE(ROUND(AVG(met.response_time_ms)), 0) as latency,
                NOW()
            FROM monitors m
            LEFT JOIN monitor_metrics met ON m.id = met.monitor_id AND met.recorded_at > NOW() - INTERVAL '24 hours'
            GROUP BY m.id
            ON CONFLICT (monitor_id) DO UPDATE SET
                uptime_24h = EXCLUDED.uptime_24h,
                avg_latency_24h = EXCLUDED.avg_latency_24h,
                last_updated_at = NOW()
        `);

        await client.query('COMMIT');
        console.log(`[StatsWorker] Successfully updated all monitor stats in bulk.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[StatsWorker] Critical failure during stats computation:', err);
    } finally {
        client.release();
    }
}

/**
 * Perform Downsampling (Data Rollups)
 * Compresses metrics older than 7 days into 1-hour averages to save 98% space.
 */
async function rollupMetrics() {
    console.log('[StatsWorker] Starting metrics downsampling/rollup...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Ensure Rollup Tables Exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_metrics_hourly (
                id SERIAL PRIMARY KEY,
                agent_id INT REFERENCES agents(id) ON DELETE CASCADE,
                recorded_at TIMESTAMP NOT NULL,
                cpu_percent NUMERIC(5,2),
                ram_percent NUMERIC(5,2),
                disk_percent NUMERIC(5,2),
                net_rx_mb NUMERIC(8,3),
                net_tx_mb NUMERIC(8,3),
                UNIQUE(agent_id, recorded_at)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS monitor_metrics_hourly (
                id SERIAL PRIMARY KEY,
                monitor_id INT REFERENCES monitors(id) ON DELETE CASCADE,
                recorded_at TIMESTAMP NOT NULL,
                response_time_ms INTEGER,
                status VARCHAR(20),
                UNIQUE(monitor_id, recorded_at)
            )
        `);

        // Rollup Agent Metrics (> 7 days)
        const agentRes = await client.query(`
            INSERT INTO agent_metrics_hourly (agent_id, recorded_at, cpu_percent, ram_percent, disk_percent, net_rx_mb, net_tx_mb)
            SELECT 
                agent_id,
                date_trunc('hour', recorded_at) AS recorded_at,
                AVG(cpu_percent), 
                AVG(ram_percent), 
                AVG(disk_percent),
                SUM(net_rx_mb),
                SUM(net_tx_mb)
            FROM agent_metrics
            WHERE recorded_at < NOW() - INTERVAL '7 days'
            GROUP BY agent_id, date_trunc('hour', recorded_at)
            ON CONFLICT (agent_id, recorded_at) DO NOTHING;
        `);

        // Rollup Monitor Metrics (> 7 days)
        const monitorRes = await client.query(`
            INSERT INTO monitor_metrics_hourly (monitor_id, recorded_at, response_time_ms, status)
            SELECT 
                monitor_id,
                date_trunc('hour', recorded_at) AS recorded_at,
                AVG(response_time_ms),
                MAX(status)
            FROM monitor_metrics
            WHERE recorded_at < NOW() - INTERVAL '7 days'
            GROUP BY monitor_id, date_trunc('hour', recorded_at)
            ON CONFLICT (monitor_id, recorded_at) DO NOTHING;
        `);

        await client.query('COMMIT');
        console.log(`[StatsWorker] Metrics downsampling complete. Inserted ${agentRes.rowCount} agent hours, ${monitorRes.rowCount} monitor hours.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[StatsWorker] Rollup failed:', err.message);
    } finally {
        client.release();
    }
}

/**
 * Prune historical metrics older than tier allowance to maintain performance.
 */
async function pruneMetrics() {
    console.log('[StatsWorker] Starting tier-aware metrics pruning...');
    try {
        // This query deletes metrics based on the retentionDays of the user's tier.
        // It uses a subquery to find the appropriate cutoff for each user.
        await pool.query(`
            -- Prune Monitor Metrics
            DELETE FROM monitor_metrics
            WHERE (monitor_id, recorded_at) IN (
                SELECT mm.monitor_id, mm.recorded_at
                FROM monitor_metrics mm
                JOIN monitors m ON mm.monitor_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE mm.recorded_at < NOW() - (
                    CASE 
                        WHEN u.tier = 'business' THEN INTERVAL '365 days'
                        WHEN u.tier = 'pro'      THEN INTERVAL '30 days'
                        WHEN u.tier = 'starter'  THEN INTERVAL '7 days'
                        ELSE INTERVAL '1 day'
                    END
                )
            );

            -- Prune Agent Metrics
            DELETE FROM agent_metrics
            WHERE (agent_id, recorded_at) IN (
                SELECT am.agent_id, am.recorded_at
                FROM agent_metrics am
                JOIN agents a ON am.agent_id = a.id
                JOIN users u ON a.user_id = u.id
                WHERE am.recorded_at < NOW() - (
                    CASE 
                        WHEN u.tier = 'business' THEN INTERVAL '365 days'
                        WHEN u.tier = 'pro'      THEN INTERVAL '30 days'
                        WHEN u.tier = 'starter'  THEN INTERVAL '7 days'
                        ELSE INTERVAL '1 day'
                    END
                )
            );
        `);
        console.log('[StatsWorker] Tier-aware pruning complete.');
    } catch (err) {
        console.error('[StatsWorker] Pruning failed:', err.message);
    }
}

// ── BullMQ Worker Definition ───────────────────────────────────────────────
const statsWorker = new Worker(
    'stats-tasks',
    async (job) => {
        if (job.name === 'compute-stats') {
            await computeMonitorStats();
        } else if (job.name === 'prune-metrics') {
            await rollupMetrics();
            await pruneMetrics();
        }
    },
    { 
        connection: workerRedisConnection,
        concurrency: 1 
    }
);

statsWorker.on('completed', (job) => console.log(`[StatsWorker] Job ${job.id} (${job.name}) completed.`));
statsWorker.on('failed', (job, err) => console.error(`[StatsWorker] Job ${job.id} (${job.name}) failed:`, err));

module.exports = { computeMonitorStats, pruneMetrics, rollupMetrics, statsWorker };
