const { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics } = require('./controller');

async function monitorRoutes(fastify, options) {
    const { requireAuth } = require('../auth/middleware');
    
    // All monitor routes require authentication
    fastify.addHook('onRequest', requireAuth);

    fastify.post('/',            createMonitor);
    fastify.get('/',             getMonitors);
    fastify.put('/:id',          updateMonitor);
    fastify.delete('/:id',       deleteMonitor);
    fastify.get('/:id/metrics',  getMonitorMetrics);
}

module.exports = monitorRoutes;
