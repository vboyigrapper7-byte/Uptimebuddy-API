require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const Fastify = require('fastify');
const cors    = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');

const authRoutes    = require('./api/auth/routes');
const agentRoutes   = require('./api/agents/routes');
const monitorRoutes = require('./api/monitors/routes');
const webhookRoutes = require('./api/webhooks/routes');
const pool          = require('./core/db/pool');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

// -------------------------------------------------------------------------
const buildServer = async () => {
    const server = Fastify({
        logger: {
            level: process.env.LOG_LEVEL || 'info',
            transport: process.env.NODE_ENV !== 'production'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
        },
    });

    // ── Plugins ───────────────────────────────────────────────────────────
    const origins = ALLOWED_ORIGIN.split(',').map(o => o.trim());
    
    await server.register(cors, {
        origin: origins.length > 1 ? origins : (origins[0] === '*' ? true : origins[0]),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true,
    });

    await server.register(rateLimit, {
        global: false, // only apply where explicitly tagged
        max: 100,
        timeWindow: '1 minute',
    });

    // ── DB decorator ─────────────────────────────────────────────────────
    server.decorate('db', {
        query: (text, params) => pool.query(text, params),
    });

    // ── Health check ─────────────────────────────────────────────────────
    server.get('/health', async (request, reply) => {
        try {
            await pool.query('SELECT 1');
            return reply.send({ status: 'ok', service: 'uptimebuddy-api', db: 'connected' });
        } catch (err) {
            return reply.code(503).send({ status: 'error', db: 'disconnected' });
        }
    });

    server.get('/', async () => ({ status: 'ok', service: 'uptimebuddy-api' }));

    // ── Routes ────────────────────────────────────────────────────────────
    server.register(authRoutes,    { prefix: '/api/v1/auth' });
    server.register(agentRoutes,   { prefix: '/api/v1/agents' });
    server.register(monitorRoutes, { prefix: '/api/v1/monitors' });
    server.register(webhookRoutes, { prefix: '/api/v1/webhooks' });

    return server;
};

// ── Start ─────────────────────────────────────────────────────────────────
let serverInstance;
const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    try {
        if (serverInstance) await serverInstance.close();
        await pool.end();
        console.log('[Server] Shutdown complete.');
        process.exit(0);
    } catch (err) {
        console.error('[Server] Error during shutdown:', err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled Promise Rejection:', reason);
});

buildServer()
    .then(async (server) => {
        serverInstance = server;
        const port = parseInt(process.env.PORT || '3001', 10);
        await server.listen({ port, host: '0.0.0.0' });
    })
    .catch((err) => {
        console.error('[Server] Fatal startup error:', err);
        process.exit(1);
    });
