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

const { syncMonitors } = require('../core/queue/scheduler');
const { retentionQueue, statsQueue, reminderQueue } = require('../core/queue/setup');

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
