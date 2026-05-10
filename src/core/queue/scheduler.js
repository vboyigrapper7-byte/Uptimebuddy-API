const { monitorQueue, statsQueue } = require('./setup');
const pool = require('../db/pool');

/**
 * Shared logic to add/update a monitor in the BullMQ queue
 */
async function scheduleMonitor(monitor) {
    try {
        // We use a predictable repeatable jobId so we can easily find/remove it
        const repeatableJobId = `monitor-${monitor.id}`;
        
        await monitorQueue.add(
            `check-${monitor.id}`,
            { monitorId: monitor.id, type: monitor.type, target: monitor.target },
            {
                repeat: { every: monitor.interval_seconds * 1000 },
                jobId: repeatableJobId,
                removeOnComplete: { count: 10 },
                removeOnFail: { count: 50 },
                attempts: 11, // High enough to cover user-defined threshold_retries (max 10)
                backoff: {
                    type: 'exponential',
                    delay: 2000 // Start with 2s delay, then 4s, 8s...
                }
            }
        );
        console.log(`[Scheduler] Queued monitor ${monitor.id} | Interval: ${monitor.interval_seconds}s`);
    } catch (err) {
        console.error(`[Scheduler] Failed to queue monitor ${monitor.id}:`, err.message);
        throw err;
    }
}

/**
 * Remove a monitor from the queue
 */
async function unscheduleMonitor(monitorId) {
    try {
        const repeatableJobs = await monitorQueue.getRepeatableJobs();
        const job = repeatableJobs.find(j => j.id === `monitor-${monitorId}`);
        if (job) {
            await monitorQueue.removeRepeatableByKey(job.key);
            console.log(`[Scheduler] Removed monitor ${monitorId} from queue`);
        }
    } catch (err) {
        console.warn(`[Scheduler] Warning while unscheduling monitor ${monitorId}:`, err.message);
    }
}

/**
 * Scan Database and synchronize with Redis queue
 * Ensuring no monitor is left orphaned.
 */
async function syncMonitors() {
    console.log('[Scheduler] Starting monitor synchronization...');
    try {
        const planService = require('../billing/planService');

        // 1. Fetch all active (non-paused) monitors with user tier info
        const res = await pool.query(
            `SELECT m.id, m.type, m.target, m.interval_seconds, m.status,
                    u.tier, u.plan_expiry
             FROM monitors m
             JOIN users u ON m.user_id = u.id
             WHERE m.status != 'paused'`
        );
        const dbMonitors = res.rows;
        
        // 2. Fetch all repeatable jobs currently in BullMQ
        const repeatableJobs = await monitorQueue.getRepeatableJobs();
        const activeJobIds = new Set(repeatableJobs.map(j => j.id));

        console.log(`[Scheduler] Found ${dbMonitors.length} active monitors in DB and ${activeJobIds.size} jobs in Queue`);

        let syncCount = 0;
        for (const monitor of dbMonitors) {
            const expectedJobId = `monitor-${monitor.id}`;

            // Enforce tier-based interval minimum during sync
            const tierConfig = planService.getEffectiveTier({ tier: monitor.tier, plan_expiry: monitor.plan_expiry });
            const minAllowed = tierConfig.minInterval || 300;
            const effectiveInterval = Math.max(monitor.interval_seconds, minAllowed);

            // If DB interval needs correction, update it
            if (effectiveInterval !== monitor.interval_seconds) {
                console.log(`[Scheduler] Correcting interval for monitor ${monitor.id}: ${monitor.interval_seconds}s → ${effectiveInterval}s (tier: ${tierConfig.id})`);
                await pool.query('UPDATE monitors SET interval_seconds = $1 WHERE id = $2', [effectiveInterval, monitor.id]);
                monitor.interval_seconds = effectiveInterval;
            }
            
            // Check if it's already in the queue with the CORRECT interval
            const existingJob = repeatableJobs.find(j => j.id === expectedJobId);
            
            if (!existingJob || existingJob.every !== (monitor.interval_seconds * 1000)) {
                if (existingJob) {
                    console.log(`[Scheduler] Interval mismatch detected for monitor ${monitor.id}. Re-scheduling...`);
                    await monitorQueue.removeRepeatableByKey(existingJob.key);
                } else {
                    console.log(`[Scheduler] Syncing missing monitor ${monitor.id}...`);
                }
                
                await scheduleMonitor(monitor);
                syncCount++;
            }
        }

        // 3. Cleanup jobs that don't exist in DB or are paused
        const activeDbIds = new Set(dbMonitors.map(m => `monitor-${m.id}`));
        for (const job of repeatableJobs) {
            if (!activeDbIds.has(job.id)) {
                console.log(`[Scheduler] Cleaning up orphaned/paused job in queue: ${job.id}`);
                await monitorQueue.removeRepeatableByKey(job.key);
            }
        }

        console.log(`[Scheduler] Synchronization complete. Balanced ${syncCount} monitors.`);

        // 4. Schedule recurring maintenance tasks
        // Every 5 minutes: Update monitor stats
        await statsQueue.add('compute-stats', {}, {
            repeat: { pattern: '*/5 * * * *' },
            jobId: 'maintenance-stats'
        });

        // Every 24 hours: Prune old metrics
        await statsQueue.add('prune-metrics', {}, {
            repeat: { pattern: '0 0 * * *' },
            jobId: 'maintenance-pruning'
        });
        
        console.log('[Scheduler] Recurring maintenance tasks scheduled.');
    } catch (err) {
        console.error('[Scheduler] Sync failed:', err.message);
    }
}

module.exports = { scheduleMonitor, unscheduleMonitor, syncMonitors };
