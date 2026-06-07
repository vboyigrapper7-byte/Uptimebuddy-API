const controller = require('./controller');
const { requireAuth } = require('../auth/middleware');

async function routes(fastify, options) {
    fastify.post('/', { preHandler: [requireAuth] }, controller.requestReport);
    fastify.get('/', { preHandler: [requireAuth] }, controller.getReports);
    fastify.delete('/:id', { preHandler: [requireAuth] }, controller.deleteReport);
}

module.exports = routes;
