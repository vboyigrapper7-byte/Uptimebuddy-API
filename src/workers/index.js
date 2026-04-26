/**
 * Monitor Hub Worker Entry Point
 * Loads all backend background workers.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

console.log('--- Starting Monitor Hub Workers ---');

require('./checkWorker');
require('./alertWorker');
require('./retentionWorker');
require('./statsWorker');
require('./reminderWorker');
require('./agentWorker');

const { syncMonitors } = require('../core/queue/scheduler');
const { retentionQueue, statsQueue, reminderQueue, agentQueue } = require('../core/queue/setup');

console.log('--- All Workers Initialized ---');

// 1. Sync monitors on startup
syncMonitors()
    .then(() => console.log('[Worker] Monitor synchronization complete.'))
    .catch(err => console.error('[Worker] Sync error:', err));

// 2. Schedule Nightly Retention Cleanup (Runs daily at midnight)
retentionQueue.add(
    'nightly-cleanup', 
    {}, 
    { 
        repeat: { pattern: '0 0 * * *' },
        jobId: 'system-retention-job' 
    }
).then(() => console.log('[Worker] Nightly retention job scheduled.'));

// 3. Schedule Periodic Stats Computation (Runs every 5 minutes)
statsQueue.add(
    'compute-stats',
    {},
    {
        repeat: { every: 5 * 60 * 1000 },
        jobId: 'system-stats-job'
    }
).then(() => console.log('[Worker] Periodic stats computation job scheduled.'));

// 4. Schedule Reminder Checks (Runs every 10 minutes)
reminderQueue.add(
    'persistent-outage-check',
    {},
    {
        repeat: { every: 10 * 60 * 1000 },
        jobId: 'system-reminder-job'
    }
).then(() => console.log('[Worker] Periodic reminder check job scheduled.'));

// 5. Schedule Agent Health Checks (Runs every 1 minute)
agentQueue.add(
    'check-health',
    {},
    {
        repeat: { every: 60 * 1000 },
        jobId: 'system-agent-health-job'
    }
).then(() => console.log('[Worker] Periodic agent health check job scheduled.'));

// 5. SELF-HEALING: Periodic Sync (Runs every hour)
// This ensures that if Redis is ever wiped/restarted, the monitors are re-queued automatically.
const { Queue } = require('bullmq');
const { redisConnection } = require('../core/queue/setup');
const syncQueue = new Queue('sync-tasks', { connection: redisConnection });

// Use a simple setInterval or a BullMQ repeat job for the worker itself to trigger sync
setInterval(async () => {
    console.log('[Worker] Running periodic self-healing sync...');
    try {
        await syncMonitors();
    } catch (err) {
        console.error('[Worker] Periodic sync failed:', err);
    }
}, 60 * 60 * 1000); // Every 1 hour
