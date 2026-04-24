const { requireAuth } = require('../auth/middleware');
const { getAlertSettings, updateAlertSettings, getAlertLogs, testEmailAlert, testWebhookAlert } = require('./controller');

async function alertRoutes(fastify, options) {
    fastify.addHook('onRequest', requireAuth);

    fastify.get('/settings', getAlertSettings);
    fastify.patch('/settings', updateAlertSettings);
    fastify.get('/history', getAlertLogs);
    fastify.post('/test-email', testEmailAlert);
    fastify.post('/test-webhook', testWebhookAlert);
}

module.exports = alertRoutes;
