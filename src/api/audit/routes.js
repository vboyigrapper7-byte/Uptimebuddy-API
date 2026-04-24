const { requireAuth, requirePlan } = require('../auth/middleware');
const auditService = require('../../core/auth/auditService');

async function auditRoutes(fastify, options) {
    fastify.addHook('preHandler', requireAuth);
    fastify.addHook('preHandler', requirePlan('audit_logs'));

    fastify.get('/logs', async (request, reply) => {
        try {
            // Find teamId for user
            const teamRes = await request.server.db.query(
                'SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1',
                [request.user.id]
            );
            if (teamRes.rows.length === 0) return reply.send([]);
            
            const logs = await auditService.getTeamLogs(teamRes.rows[0].team_id);
            return reply.send(logs);
        } catch (err) {
            return reply.status(500).send({ error: err.message });
        }
    });
}

module.exports = auditRoutes;
