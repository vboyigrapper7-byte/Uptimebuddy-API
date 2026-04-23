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
const axios = require('axios');

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

// ── Start ─────────────────────────────────────────────────────────────────
// Define routes and services inside buildServer to catch errors during initialization
const getRoutesAndServices = () => {
    return {
        authRoutes: require('./api/auth/routes'),
        agentRoutes: require('./api/agents/routes'),
        monitorRoutes: require('./api/monitors/routes'),
        webhookRoutes: require('./api/webhooks/routes'),
        publicRoutes: require('./api/public/routes'),
        billingRoutes: require('./api/billing/routes'),
        pool: require('./core/db/pool')
    };
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://monitorhubs.com';

// -------------------------------------------------------------------------
const buildServer = async () => {
    // ── Pre-boot Initialization ───────────────────────────────────────────
    // Must happen FIRST so variables like 'pool' are available to decorators
    const { authRoutes, agentRoutes, monitorRoutes, webhookRoutes, publicRoutes, billingRoutes, pool } = getRoutesAndServices();

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
        logger.error(`[Fatal Server Error] ${request.method} ${request.url}`, { 
            message: error.message, 
            stack: error.stack,
            code: error.code
        });
        const statusCode = error.statusCode || 500;
        reply.status(statusCode).send({
            error: true,
            message: statusCode === 500 ? `Internal Server Error: ${error.message}` : error.message
        });
    });

    const origins = [
        'http://localhost:3000',
        'https://monitorhubs.com',
        'https://api.monitorhubs.com',
        'https://uptimebuddy-dashboard.pages.dev',
        ...(ALLOWED_ORIGIN.split(',').map(o => o.trim()).filter(o => o && o !== '*'))
    ];
    
    await server.register(cors, {
        origin: (origin, cb) => {
            if (!origin || origins.includes(origin)) {
                cb(null, true);
                return;
            }
            cb(new Error('Not allowed by CORS'), false);
        },
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

    // ── Health check (Diagnostic Tool) ──────────────────────────────────
    server.get('/health', async (request, reply) => {
        const diagnostics = {
            status: 'ok',
            service: 'monitorhub-api',
            database: 'unknown',
            table_check: 'unknown',
            error: null
        };

        try {
            // Check connection
            await pool.query('SELECT 1');
            diagnostics.database = 'connected';
            
            // Check for users table
            await pool.query('SELECT id FROM users LIMIT 1');
            diagnostics.table_check = 'users table exists';
            
            return reply.send(diagnostics);
        } catch (err) {
            diagnostics.status = 'error';
            diagnostics.database = 'disconnected';
            diagnostics.error = err.message;
            diagnostics.hint = "Check if DATABASE_URL is correct and schema.sql has been run.";
            return reply.code(503).send(diagnostics);
        }
    });

    server.get('/', async () => ({ status: 'ok', service: 'monitorhub-api' }));

    // ── Routes ────────────────────────────────────────────────────────────
    server.register(authRoutes,    { prefix: '/api/v1/auth' });
    server.register(agentRoutes,   { prefix: '/api/v1/agents' });
    server.register(monitorRoutes, { prefix: '/api/v1/monitors' });
    server.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
    server.register(publicRoutes,  { prefix: '/api/v1/public' });
    server.register(billingRoutes, { prefix: '/api/v1/billing' });

    return server;
};

// ── Start ─────────────────────────────────────────────────────────────────
let serverInstance;
const shutdown = async (signal) => {
    logger.info(`[Server] Received ${signal}. Shutting down gracefully...`);
    try {
        if (serverInstance) await serverInstance.close();
        const { pool } = getRoutesAndServices();
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

process.on('uncaughtException', (err) => {
    console.error('------- CRITICAL UNCAUGHT EXCEPTION -------');
    console.error(err.stack || err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('------- CRITICAL UNHANDLED REJECTION -------');
    console.error(reason);
});

if (require.main === module) {
    buildServer()
        .then(async (server) => {
            serverInstance = server;

            const port = parseInt(process.env.PORT || '3001', 10);
            await server.listen({ port, host: '0.0.0.0' });
            logger.info(`[Server] API process listening on port ${port}`);

            // ── Render Keep-Alive (Self-Ping) ─────────────────────────────
            // Pings the health endpoint every 10 minutes to prevent sleeping
            // on Render/Heroku free tiers.
            if (process.env.NODE_ENV === 'production') {
                const SELF_URL = process.env.BACKEND_URL || `http://localhost:${port}`;
                setInterval(async () => {
                    try {
                        const res = await axios.get(`${SELF_URL}/health`, { timeout: 5000 });
                        logger.info(`[Keep-Alive] Self-ping successful: ${res.status}`);
                    } catch (err) {
                        logger.warn(`[Keep-Alive] Self-ping failed: ${err.message}`);
                    }
                }, 10 * 60 * 1000); // 10 minutes
            }
        })
        .catch((err) => {
            logger.error('[Server] Fatal startup error:', { 
                message: err.message, 
                stack: err.stack,
                code: err.code 
            });
            process.exit(1);
        });
}

module.exports = { buildServer };
