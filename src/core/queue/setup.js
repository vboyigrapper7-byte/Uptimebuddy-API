require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
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

// Separate connection used by Workers (checkWorker, alertWorker)
const workerRedisConnection = makeRedisConnection();

const monitorQueue   = new Queue('monitor-checks',  { connection: redisConnection });
const alertQueue     = new Queue('alert-webhooks',  { connection: redisConnection });
const retentionQueue = new Queue('retention-tasks', { connection: redisConnection });

module.exports = { redisConnection, workerRedisConnection, monitorQueue, alertQueue, retentionQueue };
