const { createOrder, verifyPayment, getPlans } = require('./controller');
const { requireAuth } = require('../auth/middleware');

async function billingRoutes(fastify, options) {
    // Both endpoints require the user to be logged in
    fastify.post('/create-order', { preHandler: [requireAuth] }, createOrder);
    fastify.post('/verify', { preHandler: [requireAuth] }, verifyPayment);
    fastify.get('/plans', getPlans);
}

module.exports = billingRoutes;
