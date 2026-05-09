/**
 * Monitor Hub Admin Routes
 */

const controller = require('./controller');
const { requireAdminAuth } = require('./middleware');

async function adminRoutes(fastify, options) {
    
    // ── Public Routes (Admin Auth) ────────────────────────────────────────
    fastify.post('/login', controller.login);
    
    // ── Protected Admin Routes ────────────────────────────────────────────
    fastify.register(async (protectedScope) => {
        protectedScope.addHook('onRequest', requireAdminAuth);

        protectedScope.post('/logout', controller.logout);
        protectedScope.get('/overview', controller.getOverview);
        
        // Users Management
        protectedScope.get('/users', controller.getUsers);
        protectedScope.get('/users/:id', controller.getUserDetails);
        protectedScope.put('/users/:id', controller.updateUser);
        protectedScope.delete('/users/:id', controller.deleteUser);
        protectedScope.post('/users/:id/impersonate', controller.impersonate);
        protectedScope.get('/analytics/revenue', controller.getRevenueAnalytics);


        
        // Monitors & Agents Management
        protectedScope.get('/monitors', controller.getMonitors);
        protectedScope.delete('/monitors/:id', controller.deleteMonitor);
        
        protectedScope.get('/agents', controller.getAgents);
        protectedScope.delete('/agents/:id', controller.deleteAgent);
        
        // Logs
        protectedScope.get('/logs', controller.getSystemLogs);
    });
}

module.exports = adminRoutes;
