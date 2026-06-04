const { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics, getMonitorLogs, getIncidents, testMonitor, toggleMonitorStatus, getSSLDetails, triggerSSLCheck } = require('./controller');

async function monitorRoutes(fastify, options) {
    const { requireAuth } = require('../auth/middleware');
    
    // All monitor routes require authentication
    fastify.addHook('onRequest', requireAuth);

    fastify.post('/', { 
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, createMonitor);
    
    fastify.post('/test', { 
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, testMonitor);
    fastify.post('/:id/toggle',  toggleMonitorStatus);
    fastify.get('/',             getMonitors);
    fastify.put('/:id',          updateMonitor);
    fastify.delete('/:id',       deleteMonitor);
    fastify.get('/:id/metrics',  getMonitorMetrics);
    fastify.get('/incidents',    getIncidents);
    fastify.get('/:id/logs',     getMonitorLogs);
    fastify.get('/:id/ssl',      getSSLDetails);
    fastify.post('/:id/ssl/check', {
        config: { rateLimit: { max: 3, timeWindow: '1 minute' } }
    }, triggerSSLCheck);
}

module.exports = monitorRoutes;
