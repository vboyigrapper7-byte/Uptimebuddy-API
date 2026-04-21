const { monitorQueue } = require('./setup');
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
        // 1. Fetch all monitors from DB
        const res = await pool.query(
            'SELECT id, type, target, interval_seconds FROM monitors'
        );
        const dbMonitors = res.rows;
        
        // 2. Fetch all repeatable jobs currently in BullMQ
        const repeatableJobs = await monitorQueue.getRepeatableJobs();
        const activeJobIds = new Set(repeatableJobs.map(j => j.id));

        console.log(`[Scheduler] Found ${dbMonitors.length} monitors in DB and ${activeJobIds.size} jobs in Queue`);

        let syncCount = 0;
        for (const monitor of dbMonitors) {
            const expectedJobId = `monitor-${monitor.id}`;
            
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

        // 3. (Optional) Cleanup jobs that don't exist in DB
        const dbIds = new Set(dbMonitors.map(m => `monitor-${m.id}`));
        for (const job of repeatableJobs) {
            if (!dbIds.has(job.id)) {
                console.log(`[Scheduler] Cleaning up orphaned job in queue: ${job.id}`);
                await monitorQueue.removeRepeatableByKey(job.key);
            }
        }

        console.log(`[Scheduler] Synchronization complete. Balanced ${syncCount} monitors.`);
    } catch (err) {
        console.error('[Scheduler] Sync failed:', err.message);
    }
}

module.exports = { scheduleMonitor, unscheduleMonitor, syncMonitors };
