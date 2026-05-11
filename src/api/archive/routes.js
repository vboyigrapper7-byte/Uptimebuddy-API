const { getSettings, updateSettings, getHistory, downloadArchive, triggerManualArchive } = require('./controllers/archiveController');
const { requireAuth } = require('../auth/middleware');

async function archiveRoutes(fastify, options) {
    // All archive routes require authentication
    fastify.addHook('preHandler', requireAuth);

    fastify.get('/settings', getSettings);
    fastify.put('/settings', updateSettings);
    fastify.get('/history', getHistory);
    fastify.get('/:id/download', downloadArchive);
    fastify.post('/manual', triggerManualArchive);
}

module.exports = archiveRoutes;
