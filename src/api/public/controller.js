const getPublicStatus = async (request, reply) => {
    const { slug } = request.params;

    if (!slug) return reply.code(400).send({ error: 'Slug is required' });

    try {
        // Find user by slug
        const userRes = await request.server.db.query(
            'SELECT id, name FROM users WHERE status_slug = $1',
            [slug]
        );

        if (userRes.rows.length === 0) {
            return reply.code(404).send({ error: 'Status page not found' });
        }

        const userId = userRes.rows[0].id;

        // Fetch active monitors for this user
        const monitorsRes = await request.server.db.query(
            `SELECT id, name, type, status 
             FROM monitors 
             WHERE user_id = $1 AND interval_seconds > 0
             ORDER BY name ASC`,
            [userId]
        );

        // Fetch recent incidents (last 7 days)
        const incidentsRes = await request.server.db.query(
            `SELECT i.id, i.monitor_id, m.name AS monitor_name, 
                    i.started_at, i.resolved_at, i.error_message
             FROM incidents i
             JOIN monitors m ON i.monitor_id = m.id
             WHERE m.user_id = $1 AND i.started_at >= NOW() - INTERVAL '7 days'
             ORDER BY i.started_at DESC
             LIMIT 50`,
            [userId]
        );

        return reply.send({
            page: {
                name: userRes.rows[0].name || 'MonitorHub User Status Page'
            },
            monitors: monitorsRes.rows,
            incidents: incidentsRes.rows
        });
    } catch (error) {
        request.log.error(error, 'getPublicStatus error');
        return reply.code(500).send({ error: 'Failed to fetch status page data' });
    }
};

module.exports = { getPublicStatus };
