// Note: dotenv is loaded by the calling entry point (server.js / workers) before this module is imported.
const { Queue } = require('bullmq');
const Redis = require('ioredis');

if (!process.env.REDIS_URL) {
    console.warn('[Queue] REDIS_URL not set, defaulting to redis://localhost:6379');
}

/**
 * BullMQ requires separate Redis connections for:
 * - Queue (producer/commands)
 * - Worker (blocking BRPOP listener)
 * Using the same connection for both can cause subtle issues.
 */
const makeRedisConnection = () => new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// Connection used by Queue producers (server.js, controllers)
const redisConnection = makeRedisConnection();

redisConnection.on('error', (err) => {
    console.error(`[Queue Redis] Producer Connection Error: ${err.message}`);
});

redisConnection.on('connect', () => {
    console.log('[Queue Redis] Producer connected successfully');
});

// Separate connection used by Workers (checkWorker, alertWorker)
const workerRedisConnection = makeRedisConnection();

workerRedisConnection.on('error', (err) => {
    console.error(`[Queue Redis] Worker Connection Error: ${err.message}`);
});

workerRedisConnection.on('connect', () => {
    console.log('[Queue Redis] Worker connected successfully');
});

const jobOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    // Keep last 100 completed and 200 failed jobs for debugging/audit
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 }
};

const monitorQueue   = new Queue('monitor-checks',  { connection: redisConnection, defaultJobOptions: jobOptions });
const alertQueue     = new Queue('alert-webhooks',  { connection: redisConnection, defaultJobOptions: jobOptions });
const retentionQueue = new Queue('retention-tasks', { connection: redisConnection, defaultJobOptions: jobOptions });
const statsQueue     = new Queue('stats-tasks',     { connection: redisConnection, defaultJobOptions: jobOptions });
const reminderQueue  = new Queue('reminder-checks',  { connection: redisConnection, defaultJobOptions: jobOptions });

module.exports = { redisConnection, workerRedisConnection, monitorQueue, alertQueue, retentionQueue, statsQueue, reminderQueue };
