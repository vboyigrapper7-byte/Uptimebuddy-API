const pool = require('../db/pool');
const cache = require('./cache');

/**
 * StatusPageService
 * Manages the aggregation of uptime data and incidents for public consumption.
 */
class StatusPageService {
    /**
     * Fetch public status data for a given slug.
     */
    async getPublicStatus(slug) {
        // 1. Check cache first
        const cached = cache.get(slug);
        if (cached) return cached;

        // 2. Fetch Page Config
        const pageRes = await pool.query(
            'SELECT * FROM status_pages WHERE slug = $1',
            [slug]
        );
        if (pageRes.rows.length === 0) return null;

        const page = pageRes.rows[0];

        // 3. Fetch Monitors and their latest status for this team
        const monitorsRes = await pool.query(
            `SELECT m.id, m.name, m.status, m.type, m.target,
                    (SELECT recorded_at FROM monitor_metrics WHERE monitor_id = m.id ORDER BY recorded_at DESC LIMIT 1) as last_checked
             FROM monitors m
             WHERE m.team_id = $1 OR m.user_id = (SELECT owner_id FROM teams WHERE id = $1)`,
            [page.team_id]
        );

        // 4. Fetch Recent Incidents (Last 7 days)
        const incidentsRes = await pool.query(
            `SELECT i.*, m.name as monitor_name
             FROM incidents i
             JOIN monitors m ON i.monitor_id = m.id
             WHERE (m.team_id = $1 OR m.user_id = (SELECT owner_id FROM teams WHERE id = $1))
               AND i.started_at > NOW() - INTERVAL '7 days'
             ORDER BY i.started_at DESC`,
            [page.team_id]
        );

        const data = {
            page: {
                name: page.name,
                slug: page.slug,
                config: page.config
            },
            monitors: monitorsRes.rows,
            incidents: incidentsRes.rows,
            overall_status: monitorsRes.rows.every(m => m.status === 'up') ? 'operational' : 'degraded',
            updated_at: new Date().toISOString()
        };

        // 5. Cache result
        cache.set(slug, data);

        return data;
    }
}

module.exports = new StatusPageService();
