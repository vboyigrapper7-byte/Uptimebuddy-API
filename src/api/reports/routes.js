const controller = require('./controller');
const { requireAuth } = require('../auth/middleware');

async function routes(fastify, options) {
    fastify.post('/', { preHandler: [requireAuth] }, controller.requestReport);
    fastify.get('/', { preHandler: [requireAuth] }, controller.getReports);
}

module.exports = routes;
