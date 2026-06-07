const { reportQueue } = require('../../core/queue/setup');
const { z } = require('zod');
const { checkLimit } = require('../../core/auth/usageService');

const CreateReportSchema = z.object({
    monitor_id: z.number().int().optional().nullable(),
    agent_id: z.number().int().optional().nullable(),
    type: z.enum(['sla', 'uptime', 'incident', 'server_telemetry', 'audit_logs']),
    range: z.string().default('30d')
});

const requestReport = async (request, reply) => {
    const parsed = CreateReportSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const { monitor_id, agent_id, type, range } = parsed.data;
    const userId = request.user.id;

    try {
        // Enforce Quota
        await checkLimit(request.server.db, request.user, 'reports');

        // Verify target ownership if applicable
        if (type === 'server_telemetry') {
            if (!agent_id) return reply.code(400).send({ error: 'Server selection is required' });
            const agentRes = await request.server.db.query('SELECT id FROM agents WHERE id = $1 AND user_id = $2', [agent_id, userId]);
            if (agentRes.rows.length === 0) return reply.code(404).send({ error: 'Server not found' });
        } else if (type !== 'audit_logs') {
            if (!monitor_id) return reply.code(400).send({ error: 'Monitor selection is required' });
            const monitorRes = await request.server.db.query('SELECT id FROM monitors WHERE id = $1 AND user_id = $2', [monitor_id, userId]);
            if (monitorRes.rows.length === 0) return reply.code(404).send({ error: 'Monitor not found' });
        }

        // Create DB record
        const res = await request.server.db.query(
            'INSERT INTO reports (user_id, monitor_id, type, config) VALUES ($1, $2, $3, $4) RETURNING id',
            [userId, monitor_id || null, type, JSON.stringify({ range, agent_id: agent_id || null })]
        );
        const reportId = res.rows[0].id;

        // Queue job
        await reportQueue.add(`report-${reportId}`, {
            reportId,
            userId,
            monitor_id: monitor_id || null,
            agent_id: agent_id || null,
            type,
            config: { range }
        });

        return reply.code(201).send({ message: 'Report generation started', reportId });
    } catch (err) {
        request.log.error(err, 'requestReport error');
        const statusCode = err.statusCode || 500;
        return reply.code(statusCode).send({ error: err.message || 'Failed to request report' });
    }
};

const getReports = async (request, reply) => {
    const userId = request.user.id;
    try {
        const res = await request.server.db.query(
            `SELECT r.*, 
                    m.name as monitor_name,
                    a.name as agent_name
             FROM reports r 
             LEFT JOIN monitors m ON r.monitor_id = m.id 
             LEFT JOIN agents a ON r.config->>'agent_id' = a.id::text
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

const deleteReport = async (request, reply) => {
    const reportId = parseInt(request.params.id, 10);
    const userId = request.user.id;

    if (isNaN(reportId)) {
        return reply.code(400).send({ error: 'Invalid report ID' });
    }

    try {
        const reportRes = await request.server.db.query(
            'SELECT * FROM reports WHERE id = $1 AND user_id = $2',
            [reportId, userId]
        );
        if (reportRes.rows.length === 0) {
            return reply.code(404).send({ error: 'Report not found' });
        }

        const report = reportRes.rows[0];

        // Delete from database
        await request.server.db.query(
            'DELETE FROM reports WHERE id = $1 AND user_id = $2',
            [reportId, userId]
        );

        // Delete physical file if it exists
        if (report.url) {
            const path = require('path');
            const fs = require('fs');
            const filename = path.basename(report.url);
            const filePath = path.resolve(__dirname, '../../../public/reports', filename);
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (err) request.log.error(err, 'Failed to delete report file');
                });
            }
        }

        return reply.send({ success: true, message: 'Report deleted successfully' });
    } catch (err) {
        request.log.error(err, 'deleteReport error');
        return reply.code(500).send({ error: 'Failed to delete report' });
    }
};

module.exports = { requestReport, getReports, deleteReport };
