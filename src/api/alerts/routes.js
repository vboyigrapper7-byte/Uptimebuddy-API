const { requireAuth } = require('../auth/middleware');
const { getAlertSettings, updateAlertSettings, getAlertLogs, testEmailAlert, testWebhookAlert, getAlertResources, toggleResourceAlert } = require('./controller');

async function alertRoutes(fastify, options) {
    fastify.addHook('onRequest', requireAuth);

    fastify.get('/settings', getAlertSettings);
    fastify.put('/settings', updateAlertSettings);
    fastify.patch('/settings', updateAlertSettings);
    fastify.get('/history', getAlertLogs);
    fastify.post('/test-email', testEmailAlert);
    fastify.post('/test-webhook', testWebhookAlert);
    
    fastify.get('/resources', getAlertResources);
    fastify.post('/resources/toggle', toggleResourceAlert);
}

module.exports = alertRoutes;
