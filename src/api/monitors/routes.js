const { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics, getIncidents } = require('./controller');

async function monitorRoutes(fastify, options) {
    const { requireAuth } = require('../auth/middleware');
    
    // All monitor routes require authentication
    fastify.addHook('onRequest', requireAuth);

    fastify.post('/',            createMonitor);
    fastify.get('/',             getMonitors);
    fastify.put('/:id',          updateMonitor);
    fastify.delete('/:id',       deleteMonitor);
    fastify.get('/:id/metrics',  getMonitorMetrics);
    fastify.get('/incidents',    getIncidents);
}

module.exports = monitorRoutes;
