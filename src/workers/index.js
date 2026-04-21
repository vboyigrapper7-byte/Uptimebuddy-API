/**
 * Monitor Hub Worker Entry Point
 * Loads all backend background workers.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

console.log('--- Starting Monitor Hub Workers ---');

require('./checkWorker');
require('./alertWorker');
require('./retentionWorker');

const { syncMonitors } = require('../core/queue/scheduler');
const { retentionQueue } = require('../core/queue/setup');

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
