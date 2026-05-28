const { getSettings, updateSettings, getHistory, downloadArchive, triggerManualArchive } = require('./controllers/archiveController');
const { requireAuth, requirePlan } = require('../auth/middleware');

async function archiveRoutes(fastify, options) {
    // All archive routes require authentication and Pro+ plan
    fastify.addHook('preHandler', requireAuth);
    fastify.addHook('preHandler', requirePlan('data_archival'));

    fastify.get('/settings', getSettings);
    fastify.put('/settings', updateSettings);
    fastify.get('/history', getHistory);
    fastify.get('/:id/download', downloadArchive);
    fastify.post('/manual', triggerManualArchive);
}

module.exports = archiveRoutes;
