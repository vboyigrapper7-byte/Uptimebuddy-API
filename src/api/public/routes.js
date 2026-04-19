const { getPublicStatus } = require('./controller');

async function publicRoutes(fastify, options) {
    // Unauthenticated route for the public status page
    fastify.get('/status/:slug', getPublicStatus);
}

module.exports = publicRoutes;
