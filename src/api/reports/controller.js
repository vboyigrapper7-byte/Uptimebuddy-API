const { reportQueue } = require('../../core/queue/setup');
const { z } = require('zod');
const { checkLimit } = require('../../core/auth/usageService');

const CreateReportSchema = z.object({
    monitor_id: z.number().int(),
    type: z.enum(['sla', 'uptime', 'incident']),
    range: z.string().default('30d')
});

const requestReport = async (request, reply) => {
    const parsed = CreateReportSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const { monitor_id, type, range } = parsed.data;
    const userId = request.user.id;

    try {
        // Enforce Quota
        await checkLimit(request.server.db, request.user, 'reports');

        // Verify ownership
        const monitorRes = await request.server.db.query('SELECT id FROM monitors WHERE id = $1 AND user_id = $2', [monitor_id, userId]);
        if (monitorRes.rows.length === 0) return reply.code(404).send({ error: 'Monitor not found' });

        // Create DB record
        const res = await request.server.db.query(
            'INSERT INTO reports (user_id, monitor_id, type, config) VALUES ($1, $2, $3, $4) RETURNING id',
            [userId, monitor_id, type, JSON.stringify({ range })]
        );
        const reportId = res.rows[0].id;

        // Queue job
        await reportQueue.add(`report-${reportId}`, {
            reportId,
            userId,
            monitor_id,
            type,
            config: { range }
        });

        return reply.code(201).send({ message: 'Report generation started', reportId });
    } catch (err) {
        request.log.error(err, 'requestReport error');
        return reply.code(500).send({ error: 'Failed to request report' });
    }
};

const getReports = async (request, reply) => {
    const userId = request.user.id;
    try {
        const res = await request.server.db.query(
            `SELECT r.*, m.name as monitor_name 
             FROM reports r 
             LEFT JOIN monitors m ON r.monitor_id = m.id 
             WHERE r.user_id = $1 
             ORDER BY r.created_at DESC`,
            [userId]
        );
        return reply.send(res.rows);
    } catch (err) {
        request.log.error(err, 'getReports error');
        return reply.code(500).send({ error: 'Failed to fetch reports' });
    }
};

module.exports = { requestReport, getReports };
