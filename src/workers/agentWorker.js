/**
 * Monitor Hub Agent Health Worker
 * Periodically checks for agents that haven't reported in 2+ minutes
 * and marks them as 'down' to ensure dashboard accuracy.
 */
const pool = require('../core/db/pool');
const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');

async function checkAgentHealth() {
    console.log('[AgentWorker] Checking for offline agents...');
    try {
        // Mark agents as 'down' if not seen in 2 minutes
        const res = await pool.query(`
            UPDATE agents 
            SET status = 'down' 
            WHERE status != 'down' 
            AND last_seen < NOW() - INTERVAL '2 minutes'
            RETURNING id, name, hostname, user_id
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

                // Record the incident
                pool.query(
                    'INSERT INTO incidents (agent_id, started_at, error_message) VALUES ($1, NOW(), $2)', 
                    [agent.id, 'Server agent stopped reporting heartbeats.']
                ).catch(e => console.error('[AgentWorker] Failed to create incident:', e));

                const { alertQueue } = require('../core/queue/setup');
                alertQueue.add(
                    `alert-agent-${agent.id}-${Date.now()}`,
                    { 
                        monitorId: agent.id,
                        isAgent: true,
                        target: agent.name || agent.hostname || 'Server Agent', 
                        previousStatus: 'up', 
                        newStatus: 'down', 
                        errorMessage: 'Server agent stopped reporting heartbeats.', 
                        timestamp: new Date().toISOString() 
                    },
                    { removeOnComplete: { count: 100 } }
                ).catch(err => console.error('[AgentWorker] Failed to queue alert', err));

                // Invalidate Public Status Page Cache for this user
                pool.query('SELECT status_slug FROM users WHERE id = $1', [agent.user_id])
                    .then(uRes => {
                        if (uRes.rows.length > 0 && uRes.rows[0].status_slug) {
                            const cache = require('../core/reporting/cache');
                            cache.invalidate(uRes.rows[0].status_slug);
                        }
                    }).catch(e => console.error('[AgentWorker] Cache invalidation failed:', e));
            });
        }
    } catch (err) {
        console.error('[AgentWorker] Health check failed:', err.message);
    }
}

const agentWorker = new Worker(
    'agent-tasks',
    async (job) => {
        if (job.name === 'check-health') {
            await checkAgentHealth();
        }
    },
    { 
        connection: workerRedisConnection,
        concurrency: 1 
    }
);

agentWorker.on('completed', (job) => console.log(`[AgentWorker] Job ${job.id} completed.`));
agentWorker.on('failed', (job, err) => console.error(`[AgentWorker] Job ${job.id} failed:`, err));

module.exports = { checkAgentHealth, agentWorker };
