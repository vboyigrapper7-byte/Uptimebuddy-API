const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const Fastify = require('fastify');
const cors    = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');
const helmet = require('@fastify/helmet');
const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

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
    await server.register(helmet, {
        global: true,
        contentSecurityPolicy: process.env.NODE_ENV === 'production'
    });

    server.setErrorHandler((error, request, reply) => {
        logger.error(`[Error] ${request.method} ${request.url}`, { error: error.message, stack: error.stack });
        const statusCode = error.statusCode || 500;
        reply.status(statusCode).send({
            error: true,
            message: statusCode === 500 ? 'Internal Server Error' : error.message
        });
    });

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
    logger.info(`[Server] Received ${signal}. Shutting down gracefully...`);
    try {
        if (serverInstance) await serverInstance.close();
        await pool.end();
        logger.info('[Server] Shutdown complete.');
        process.exit(0);
    } catch (err) {
        logger.error('[Server] Error during shutdown:', err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    logger.error('[Server] Unhandled Promise Rejection:', reason);
});

buildServer()
    .then(async (server) => {
        serverInstance = server;
        const port = parseInt(process.env.PORT || '3001', 10);
        await server.listen({ port, host: '0.0.0.0' });
    })
    .catch((err) => {
        logger.error('[Server] Fatal startup error:', err);
        process.exit(1);
    });
