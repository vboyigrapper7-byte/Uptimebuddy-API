const { requireAuth } = require('../auth/middleware');
const { getAlertSettings, updateAlertSettings, getAlertLogs } = require('./controller');

async function alertRoutes(fastify, options) {
    fastify.addHook('onRequest', requireAuth);

    fastify.get('/settings', getAlertSettings);
    fastify.patch('/settings', updateAlertSettings);
    fastify.get('/history', getAlertLogs);
}

module.exports = alertRoutes;
