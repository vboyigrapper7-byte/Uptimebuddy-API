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

        // 2. Find the user who owns this slug
        const userRes = await pool.query(
            'SELECT id, name, email FROM users WHERE status_slug = $1',
            [slug]
        );
        if (userRes.rows.length === 0) return null;

        const user = userRes.rows[0];

        // 3. Fetch Monitors and their latest status for this user
        const monitorsRes = await pool.query(
            `SELECT m.id, m.name, m.status, m.type, m.target,
                    (SELECT recorded_at FROM monitor_metrics WHERE monitor_id = m.id ORDER BY recorded_at DESC LIMIT 1) as last_checked
             FROM monitors m
             WHERE m.user_id = $1`,
            [user.id]
        );

        // 4. Fetch Recent Incidents (Last 7 days)
        const incidentsRes = await pool.query(
            `SELECT i.*, m.name as monitor_name
             FROM incidents i
             JOIN monitors m ON i.monitor_id = m.id
             WHERE m.user_id = $1
               AND i.started_at > NOW() - INTERVAL '7 days'
             ORDER BY i.started_at DESC`,
            [user.id]
        );

        const data = {
            page: {
                name: user.name || slug,
                slug: slug,
                config: {}
            },
            monitors: monitorsRes.rows,
            incidents: incidentsRes.rows,
            overall_status: monitorsRes.rows.length === 0
                ? 'operational'
                : monitorsRes.rows.every(m => m.status === 'up') ? 'operational' : 'degraded',
            updated_at: new Date().toISOString()
        };

        // 5. Cache result
        cache.set(slug, data);

        return data;
    }
}

module.exports = new StatusPageService();

