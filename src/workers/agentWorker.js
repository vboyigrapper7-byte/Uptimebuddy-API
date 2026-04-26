/**
 * Monitor Hub Agent Health Worker
 * Periodically checks for agents that haven't reported in 2+ minutes
 * and marks them as 'down' to ensure dashboard accuracy.
 */
const pool = require('../core/db/pool');
const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');

async function checkAgentHealth(fastify) {
    console.log('[AgentWorker] Checking for offline agents...');
    try {
        // Mark agents as 'down' if not seen in 2 minutes
        const res = await pool.query(`
            UPDATE agents 
            SET status = 'down' 
            WHERE status != 'down' 
            AND last_seen < NOW() - INTERVAL '2 minutes'
            RETURNING id, name, hostname
        `);

        if (res.rows.length > 0) {
            console.log(`[AgentWorker] Marked ${res.rows.length} agents as OFFLINE.`);
            const redis = require('../core/db/pool'); // We can use the redis connection from setup if available
            // For now, let's use a fresh connection or the worker connection
            const { redisConnection } = require('../core/queue/setup');

            res.rows.forEach(agent => {
                console.log(`[AgentWorker] Agent Down: ${agent.name} (ID: ${agent.id})`);
                
                // Publish to Redis for the API server to pick up and broadcast to WS
                redisConnection.publish('agent-updates', JSON.stringify({
                    type: 'AGENT_UPDATE',
                    agent_id: agent.id,
                    status: 'down',
                    hostname: agent.hostname
                }));
            });
        }
    } catch (err) {
        console.error('[AgentWorker] Health check failed:', err.message);
    }
}

const startAgentWorker = (fastify) => {
    const worker = new Worker(
        'agent-tasks',
        async (job) => {
            if (job.name === 'check-health') {
                await checkAgentHealth(fastify);
            }
        },
        { 
            connection: workerRedisConnection,
            concurrency: 1 
        }
    );

    worker.on('completed', (job) => console.log(`[AgentWorker] Job ${job.id} completed.`));
    worker.on('failed', (job, err) => console.error(`[AgentWorker] Job ${job.id} failed:`, err));

    return worker;
};

module.exports = { checkAgentHealth, startAgentWorker };
