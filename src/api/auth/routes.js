/**
 * Monitor Hub Authentication Routes
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
    fastify.post('/send-otp', authRateLimit, controller.sendOTP);
    fastify.post('/verify-otp', authRateLimit, controller.verifyOTP);
    fastify.post('/resend-otp', authRateLimit, controller.resendOTP);


    // ── Protected Routes ──────────────────────────────────────────────────
    fastify.register(async (protectedScope) => {
        protectedScope.addHook('onRequest', requireAuth);

        protectedScope.get('/me', async (request, reply) => {
            // Using request.user directly because it's populated by requireAuth
            return reply.send(request.user);
        });

        protectedScope.get('/usage', async (request, reply) => {
            const usageService = require('../../core/auth/usageService');
            const usage = await usageService.getUserUsage(request.server.db, request.user.id);
            const limits = usageService.getTierLimits(request.user.tier);
            const overLimitIds = await usageService.getOverLimitMonitors(request.server.db, request.user);
            return reply.send({ usage, limits, overLimitIds });
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
