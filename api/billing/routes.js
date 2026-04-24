const { createOrder, verifyPayment, getPlans } = require('./controller');
const { handleWebhook } = require('./webhooks');
const { requireAuth } = require('../auth/middleware');

async function billingRoutes(fastify, options) {
    // These endpoints require user authentication
    fastify.post('/create-order', { preHandler: [requireAuth] }, createOrder);
    fastify.post('/verify', { preHandler: [requireAuth] }, verifyPayment);
    fastify.get('/plans', getPlans);

    // Webhooks are public but verify signature internally
    fastify.post('/webhook', handleWebhook);
}

module.exports = billingRoutes;
