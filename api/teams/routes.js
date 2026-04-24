const { requireAuth, requireTeamRole } = require('../auth/middleware');
const { getMembers, inviteMember } = require('./controller');

async function teamRoutes(fastify, options) {
    fastify.addHook('preHandler', requireAuth);

    fastify.get('/members', getMembers);
    fastify.post('/invite', { preHandler: [requireTeamRole('admin')] }, inviteMember);
}

module.exports = teamRoutes;
