const { requireAuth, requireTeamRole } = require('../auth/middleware');
const { getMembers, inviteMember, removeMember } = require('./controller');

async function teamRoutes(fastify, options) {
    fastify.addHook('preHandler', requireAuth);

    fastify.get('/members', getMembers);
    fastify.post('/invite', { preHandler: [requireTeamRole('admin')] }, inviteMember);
    fastify.post('/remove', { preHandler: [requireTeamRole('admin')] }, removeMember);
}

module.exports = teamRoutes;
