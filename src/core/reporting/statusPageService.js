const pool = require('../db/pool');
const cache = require('./cache');

/**
 * StatusPageService
 * Manages the aggregation of uptime data and incidents for public consumption.
 * 
 * The dashboard saves the slug to `users.status_slug` via the profile update endpoint.
 * This service queries by that slug to find the user and their monitors.
 */
class StatusPageService {
    /**
     * Fetch public status data for a given slug.
     */
    async getPublicStatus(slug) {
        // 1. Check cache first
        const cached = cache.get(slug);
        if (cached) return cached;

        // 2. Find the user and their effective tier/limits
        const userRes = await pool.query(
            'SELECT id, name, email, tier, plan_expiry FROM users WHERE status_slug = $1',
            [slug]
        );
        if (userRes.rows.length === 0) return null;

        const user = userRes.rows[0];
        const planService = require('../billing/planService');
        const tierConfig = planService.getEffectiveTier(user);
        const limit = tierConfig.limits.uptime || 5;

        // 3. Fetch Monitors (Respecting limit and joining stats)
        const monitorsRes = await pool.query(
            `SELECT m.id, m.name, m.status, m.type, m.target, m.interval_seconds,
                    ms.uptime_24h as uptime, ms.avg_latency_24h as latency,
                    (SELECT recorded_at FROM monitor_metrics WHERE monitor_id = m.id ORDER BY recorded_at DESC LIMIT 1) as last_checked
             FROM monitors m
             LEFT JOIN monitor_stats ms ON m.id = ms.monitor_id
             WHERE m.user_id = $1
             ORDER BY m.created_at ASC
             LIMIT $2`,
            [user.id, limit]
        );

        // 4. Fetch Recent Incidents (Last 7 days)
        const incidentsRes = await pool.query(
            `SELECT i.*, 
                    COALESCE(m.name, a.name) as monitor_name
             FROM incidents i
             LEFT JOIN monitors m ON i.monitor_id = m.id
             LEFT JOIN agents a ON i.agent_id = a.id
             WHERE (m.user_id = $1 OR a.user_id = $1)
               AND i.started_at > NOW() - INTERVAL '7 days'
             ORDER BY i.started_at DESC`,
            [user.id]
        );

        // 4.5 Fetch Servers (Agents) - Limit to tier as well if needed
        const agentLimit = tierConfig.limits.server || 1;
        const agentsRes = await pool.query(
            `SELECT id, name, status, agent_type as type, hostname, os_type, last_seen as last_checked
             FROM agents
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [user.id, agentLimit]
        );

        const activeMonitors = monitorsRes.rows.filter(m => m.status !== 'paused');
        const activeAgents = agentsRes.rows.filter(a => a.status !== 'paused');

        const data = {
            page: {
                name: user.name || slug,
                slug: slug,
                config: {}
            },
            monitors: monitorsRes.rows,
            servers: agentsRes.rows,
            incidents: incidentsRes.rows,
            overall_status: (activeMonitors.length === 0 && activeAgents.length === 0)
                ? 'operational'
                : (activeMonitors.every(m => m.status === 'up') && activeAgents.every(a => a.status === 'up')) ? 'operational' : 'degraded',
            updated_at: new Date().toISOString()
        };

        // 5. Cache result
        cache.set(slug, data);

        return data;
    }
}

module.exports = new StatusPageService();

