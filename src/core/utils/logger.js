const winston = require('winston');

/**
 * Monitor Hub Unified Logger
 * Configured for structured logging suitable for Render/CloudWatch/Datadog.
 */
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'monitorhub-backend' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Helper for worker-specific logging
logger.worker = (workerName, monitorId, message, meta = {}) => {
    logger.info(`[${workerName}][Monitor:${monitorId}] ${message}`, {
        worker: workerName,
        monitor_id: monitorId,
        ...meta
    });
};

logger.workerError = (workerName, monitorId, error, meta = {}) => {
    logger.error(`[${workerName}][Monitor:${monitorId}] ${error.message}`, {
        worker: workerName,
        monitor_id: monitorId,
        stack: error.stack,
        ...meta
    });
};

module.exports = logger;
