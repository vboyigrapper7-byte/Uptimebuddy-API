const { createOrder, verifyPayment } = require('./controller');
const { requireAuth } = require('../auth/middleware');

async function billingRoutes(fastify, options) {
    // Both endpoints require the user to be logged in
    fastify.post('/create-order', { preHandler: [requireAuth] }, createOrder);
    fastify.post('/verify', { preHandler: [requireAuth] }, verifyPayment);
}

module.exports = billingRoutes;
