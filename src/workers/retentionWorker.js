const pool = require('../core/db/pool');
const { PLAN_TIERS } = require('../core/billing/tiers');
const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');

/**
 * Enforce data retention policies
 * Marks old records for deletion and purges records that have exceeded the grace period.
 */
async function enforceRetention() {
    console.log('[RetentionWorker] Starting nightly cleanup...');
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Permanently delete metrics that have survived the 5-day grace period
        const permanentMonitor = await client.query(
            `DELETE FROM monitor_metrics 
             WHERE deletion_scheduled_at < NOW() - INTERVAL '5 days'`
        );
        const permanentAgent = await client.query(
            `DELETE FROM agent_metrics 
             WHERE deletion_scheduled_at < NOW() - INTERVAL '5 days'`
        );
        console.log(`[RetentionWorker] Purged ${permanentMonitor.rowCount} monitor & ${permanentAgent.rowCount} agent records from Recycle Bin.`);

        // 2. Mark new metrics for deletion based on Tier Allowance
        for (const [tierKey, config] of Object.entries(PLAN_TIERS)) {
            const days = Math.min(config.retentionDays || 14, 14); // Force max 14 days for safety in this pass
            
            // Mark monitor metrics
            const monitorRes = await client.query(
                `UPDATE monitor_metrics mm
                 SET deletion_scheduled_at = NOW()
                 FROM monitors m
                 JOIN users u ON m.user_id = u.id
                 WHERE mm.monitor_id = m.id
                 AND u.tier = $1
                 AND mm.recorded_at < NOW() - INTERVAL '14 days'
                 AND mm.deletion_scheduled_at IS NULL`,
                [tierKey]
            );

            // Mark agent metrics
            const agentRes = await client.query(
                `UPDATE agent_metrics am
                 SET deletion_scheduled_at = NOW()
                 FROM agents a
                 JOIN users u ON a.user_id = u.id
                 WHERE am.agent_id = a.id
                 AND u.tier = $1
                 AND am.recorded_at < NOW() - INTERVAL '${days} days'
                 AND am.deletion_scheduled_at IS NULL`,
                [tierKey]
            );

            if (monitorRes.rowCount > 0 || agentRes.rowCount > 0) {
                console.log(`[RetentionWorker] Tier [${tierKey}]: ${monitorRes.rowCount + agentRes.rowCount} records moved to Recycle Bin (Retention: ${days} days).`);
            }
        }

        await client.query('COMMIT');
        console.log('[RetentionWorker] Nightly cleanup successfully completed.');

        // 3. System Auto-Pause Pass (Safety Enforcement)
        // Automatically pause newest monitors for users over budget who haven't reconciled manually.
        console.log('[RetentionWorker] Starting auto-pause compliance check...');
        const usageService = require('../core/auth/usageService');
        const { unscheduleMonitor } = require('../core/queue/scheduler');

        const usersRes = await pool.query('SELECT id, tier FROM users');
        for (const user of usersRes.rows) {
            const overLimitIds = await usageService.getOverLimitMonitors(pool, user);
            if (overLimitIds.length > 0) {
                console.log(`[RetentionWorker] Auto-pausing ${overLimitIds.length} monitors for User ${user.id} (Over Limit)`);
                
                await pool.query(
                    'UPDATE monitors SET status = $1 WHERE id = ANY($2)',
                    ['paused', overLimitIds]
                );

                for (const id of overLimitIds) {
                    await unscheduleMonitor(id);
                }
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
        if (job.name === 'nightly-cleanup') {
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
