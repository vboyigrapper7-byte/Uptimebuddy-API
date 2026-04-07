/**
 * UptimeBuddy Authentication Routes
 */

const controller = require('./controller');
const { requireAuth, requireRole } = require('./middleware');

async function authRoutes(fastify, options) {
    
    // ── Public Routes ─────────────────────────────────────────────────────
    const authRateLimit = {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute'
            }
        }
    };

    fastify.post('/register', authRateLimit, controller.register);

    // ── Protected Routes ──────────────────────────────────────────────────
    fastify.register(async (protectedScope) => {
        protectedScope.addHook('onRequest', requireAuth);

        protectedScope.get('/me', async (request, reply) => {
            // Using request.user directly because it's populated by requireAuth
            return reply.send(request.user);
        });

        // API Key Management
        protectedScope.post('/api-key', controller.createApiKey);

        // Admin-only Example
        protectedScope.get('/admin-test', { preHandler: [requireRole('admin')] }, async () => {
            return { message: 'Welcome, Administrator.' };
        });
    });
}

module.exports = authRoutes;
