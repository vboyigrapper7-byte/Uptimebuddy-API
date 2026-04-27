const pool = require('../core/db/pool');
const { PLAN_TIERS } = require('../core/billing/tiers');
const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');

/**
 * Enforce data retention policies
 * Marks old records for deletion and purges records that have exceeded the grace period.
 */
/**
 * Helper to get current database size in bytes
 */
async function getDatabaseSize() {
    try {
        const res = await pool.query("SELECT pg_database_size(current_database()) as size");
        return parseInt(res.rows[0].size, 10);
    } catch (err) {
        console.error('[RetentionWorker] Failed to get DB size:', err);
        return 0;
    }
}

/**
 * Perform batched deletion to avoid table locks and performance spikes
 */
async function batchedDelete(client, tableName, whereClause, params = [], batchSize = 5000) {
    let totalDeleted = 0;
    let iteration = 0;

    while (true) {
        iteration++;
        const res = await client.query(
            `DELETE FROM ${tableName} 
             WHERE id IN (
                 SELECT id FROM ${tableName} 
                 WHERE ${whereClause} 
                 LIMIT $${params.length + 1}
             )`,
            [...params, batchSize]
        );

        totalDeleted += res.rowCount;
        if (res.rowCount < batchSize) break;
        
        // Small yield to allow other queries to process
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return totalDeleted;
}

/**
 * Enforce data retention policies
 */
async function enforceRetention() {
    const startTime = Date.now();
    const initialSize = await getDatabaseSize();
    const initialSizeMB = (initialSize / (1024 * 1024)).toFixed(2);
    
    console.log(`[RetentionWorker] Starting cleanup. Current DB Size: ${initialSizeMB}MB`);
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. DETERMINE AGGRESSIVENESS (150MB Safety Threshold)
        // If DB is approaching 200MB limit, we become more aggressive (1 day retention instead of 3)
        let retentionInterval = '3 days';
        if (initialSize > 150 * 1024 * 1024) {
            console.warn(`[RetentionWorker] ⚠️ CRITICAL: DB size (${initialSizeMB}MB) > 150MB. Running aggressive 1-day cleanup.`);
            retentionInterval = '1 day';
        }

        // 2. HARD PURGE: Batched deletion of old agent metrics
        const deletedMetrics = await batchedDelete(
            client, 
            'agent_metrics', 
            `recorded_at < NOW() - INTERVAL $1`, 
            [retentionInterval]
        );

        // 3. RECYCLE BIN PURGE: Permanently delete records marked for deletion (5-day grace period)
        const deletedRecycleMonitor = await batchedDelete(
            client,
            'monitor_metrics',
            `deletion_scheduled_at < NOW() - INTERVAL '5 days'`
        );
        const deletedRecycleAgent = await batchedDelete(
            client,
            'agent_metrics',
            `deletion_scheduled_at < NOW() - INTERVAL '5 days'`
        );

        // 4. SOFT PURGE: Mark new metrics based on Tier Allowance
        let softPurgeCount = 0;
        for (const [tierKey, config] of Object.entries(PLAN_TIERS)) {
            const days = Math.min(config.retentionDays || 14, 14);
            
            const monitorRes = await client.query(
                `UPDATE monitor_metrics mm
                 SET deletion_scheduled_at = NOW()
                 FROM monitors m JOIN users u ON m.user_id = u.id
                 WHERE mm.monitor_id = m.id AND u.tier = $1
                 AND mm.recorded_at < NOW() - INTERVAL '14 days'
                 AND mm.deletion_scheduled_at IS NULL`,
                [tierKey]
            );

            const agentRes = await client.query(
                `UPDATE agent_metrics am
                 SET deletion_scheduled_at = NOW()
                 FROM agents a JOIN users u ON a.user_id = u.id
                 WHERE am.agent_id = a.id AND u.tier = $1
                 AND am.recorded_at < NOW() - INTERVAL '${days} days'
                 AND am.deletion_scheduled_at IS NULL`,
                [tierKey]
            );
            softPurgeCount += (monitorRes.rowCount + agentRes.rowCount);
        }

        await client.query('COMMIT');

        const finalSize = await getDatabaseSize();
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log(`[RetentionWorker] Cleanup Finished in ${duration}s.`);
        console.log(`[Stats] Purged: ${deletedMetrics} (Hard) | ${deletedRecycleMonitor + deletedRecycleAgent} (Recycle) | ${softPurgeCount} (Soft)`);
        console.log(`[Stats] DB Size: ${initialSizeMB}MB -> ${(finalSize / (1024 * 1024)).toFixed(2)}MB`);

        // 5. System Compliance Check (Auto-pause)
        // (Existing logic for usage compliance...)
        const usageService = require('../core/auth/usageService');
        const { unscheduleMonitor } = require('../core/queue/scheduler');
        const usersRes = await pool.query('SELECT id, tier FROM users');
        for (const user of usersRes.rows) {
            const overLimitIds = await usageService.getOverLimitMonitors(pool, user);
            if (overLimitIds.length > 0) {
                await pool.query('UPDATE monitors SET status = $1 WHERE id = ANY($2)', ['paused', overLimitIds]);
                for (const id of overLimitIds) { await unscheduleMonitor(id); }
            }
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[RetentionWorker] Critical failure during cleanup:', err);
    } finally {
        client.release();
    }
}

// ── BullMQ Worker Definition ───────────────────────────────────────────────
const retentionWorker = new Worker(
    'retention-tasks',
    async (job) => {
        if (job.name === 'nightly-cleanup' || job.name === 'periodic-retention') {
            await enforceRetention();
        }
    },
    { 
        connection: workerRedisConnection,
        concurrency: 1 
    }
);

retentionWorker.on('completed', (job) => console.log(`[RetentionWorker] Job ${job.id} completed.`));
retentionWorker.on('failed', (job, err) => console.error(`[RetentionWorker] Job ${job.id} failed:`, err));

module.exports = { enforceRetention, retentionWorker };
