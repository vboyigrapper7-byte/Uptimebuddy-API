require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const tls = require('tls');
const whois = require('whois-json');
const pool = require('../core/db/pool');
const logger = require('../core/utils/logger');
const { workerRedisConnection, alertQueue } = require('../core/queue/setup');

const EXPIRY_THRESHOLD_DAYS = 14;

const expiryWorker = new Worker('expiry-checks', async (job) => {
    logger.info('[ExpiryWorker] Starting global expiry checks...');

    try {
        // Fetch all HTTPS monitors and monitors that might need domain checks
        const monitorsRes = await pool.query(
            'SELECT id, name, target, type, user_id FROM monitors WHERE status != $1',
            ['paused']
        );

        for (const monitor of monitorsRes.rows) {
            try {
                if (monitor.type === 'https' || monitor.type === 'http') {
                    await checkSSLExpiry(monitor);
                }
                await checkDomainExpiry(monitor);
            } catch (err) {
                logger.error(`[ExpiryWorker] Error checking monitor ${monitor.id}: ${err.message}`);
            }
        }

        logger.info('[ExpiryWorker] Global expiry checks completed.');
    } catch (err) {
        logger.error(`[ExpiryWorker] Critical error: ${err.message}`);
        throw err;
    }
}, {
    connection: workerRedisConnection,
    concurrency: 1, // Run sequentially to avoid rate limits on WHOIS
});

async function checkSSLExpiry(monitor) {
    if (!monitor.target.startsWith('http')) return;

    return new Promise((resolve) => {
        try {
            const url = new URL(monitor.target);
            const port = url.port || 443;
            const hostname = url.hostname;

            const socket = tls.connect(port, hostname, { servername: hostname }, () => {
                const cert = socket.getPeerCertificate();
                if (cert && cert.valid_to) {
                    const expiryDate = new Date(cert.valid_to);
                    updateMonitorExpiry(monitor.id, 'ssl', expiryDate);
                    
                    // Trigger alert if expiring soon
                    checkAndAlert(monitor, 'SSL', expiryDate);
                }
                socket.end();
                resolve();
            });

            socket.on('error', (err) => {
                logger.warn(`[ExpiryWorker] SSL check failed for ${hostname}: ${err.message}`);
                socket.destroy();
                resolve();
            });

            socket.setTimeout(10000, () => {
                socket.destroy();
                resolve();
            });
        } catch (e) {
            resolve();
        }
    });
}

async function checkDomainExpiry(monitor) {
    try {
        const url = new URL(monitor.target.includes('://') ? monitor.target : `http://${monitor.target}`);
        const hostname = url.hostname;
        
        // Skip IP addresses
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return;

        const results = await whois(hostname);
        let expiryDateStr = results.expiryDate || results.expires || results.expirationDate || results['Registry Expiry Date'];
        
        if (expiryDateStr) {
            const expiryDate = new Date(expiryDateStr);
            if (!isNaN(expiryDate.getTime())) {
                updateMonitorExpiry(monitor.id, 'domain', expiryDate);
                checkAndAlert(monitor, 'Domain', expiryDate);
            }
        }
    } catch (err) {
        logger.warn(`[ExpiryWorker] Domain check failed for ${monitor.target}: ${err.message}`);
    }
}

async function updateMonitorExpiry(monitorId, type, expiryDate) {
    const column = type === 'ssl' ? 'ssl_expiry' : 'domain_expiry';
    const checkColumn = type === 'ssl' ? 'last_ssl_check' : 'last_domain_check';
    
    await pool.query(
        `UPDATE monitors SET ${column} = $1, ${checkColumn} = NOW() WHERE id = $2`,
        [expiryDate, monitorId]
    );
}

async function checkAndAlert(monitor, label, expiryDate) {
    const daysRemaining = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
    
    if (daysRemaining <= EXPIRY_THRESHOLD_DAYS && daysRemaining >= 0) {
        logger.info(`[ExpiryWorker] Dispatching ${label} expiry alert for ${monitor.name} (${daysRemaining} days remaining)`);
        
        await alertQueue.add(
            `expiry-alert-${monitor.id}-${label.toLowerCase()}`,
            {
                monitorId: monitor.id,
                target: monitor.target,
                previousStatus: 'up',
                newStatus: 'warning',
                errorMessage: `${label} Certificate expiring in ${daysRemaining} days (Expiry: ${expiryDate.toDateString()})`,
                timestamp: new Date().toISOString()
            },
            { removeOnComplete: true }
        );
    }
}

logger.info('[ExpiryWorker] Initialized and waiting for expiry-checks queue...');

module.exports = expiryWorker;
