require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const tls = require('tls');
const whois = require('whois-json');
const pool = require('../core/db/pool');
const logger = require('../core/utils/logger');
const { workerRedisConnection, alertQueue } = require('../core/queue/setup');
const planService = require('../core/billing/planService');
const { safeLookup } = require('../core/utils/ssrf');

// Alert at 1, 7, 14, and 30 day(s) before expiry — prioritized ascendingly to evaluate most urgent first
const EXPIRY_ALERT_DAYS = [1, 7, 14, 30];

const expiryWorker = new Worker('expiry-checks', async (job) => {
    logger.info('[ExpiryWorker] Starting global expiry checks...');

    try {
        // Fetch all non-paused monitors with their user's tier for plan gating
        const monitorsRes = await pool.query(
            `SELECT m.id, m.name, m.target, m.type, m.user_id, u.tier, u.plan_expiry
             FROM monitors m
             JOIN users u ON u.id = m.user_id
             WHERE m.status != $1`,
            ['paused']
        );

        for (const monitor of monitorsRes.rows) {
            try {
                if (monitor.type === 'https' || monitor.type === 'http') {
                    // SSL monitoring is a paid feature — skip for free-tier users
                    const user = { id: monitor.user_id, tier: monitor.tier, plan_expiry: monitor.plan_expiry };
                    if (planService.canUseFeature(user, 'ssl_monitoring')) {
                        await checkSSLExpiry(monitor);
                    }
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

            const socket = tls.connect(port, hostname, { servername: hostname, rejectUnauthorized: false, lookup: safeLookup }, () => {
                try {
                    const cert = socket.getPeerCertificate(true);
                    const authorized = socket.authorized;

                    if (cert && cert.valid_to) {
                        const expiryDate = new Date(cert.valid_to);

                        // Extract comprehensive certificate details
                        const sslDetails = {
                            ssl_expiry: expiryDate,
                            ssl_valid_from: cert.valid_from ? new Date(cert.valid_from) : null,
                            ssl_issuer: formatCertField(cert.issuer),
                            ssl_subject: formatCertField(cert.subject),
                            ssl_fingerprint: cert.fingerprint256 || cert.fingerprint || null,
                            ssl_sans: extractSANs(cert.subjectaltname),
                            ssl_protocol: socket.getProtocol ? socket.getProtocol() : null,
                            ssl_cipher: socket.getCipher ? socket.getCipher().name : null,
                            ssl_is_valid: authorized && expiryDate > new Date(),
                            ssl_error: authorized ? null : (socket.authorizationError || 'Certificate validation failed'),
                        };

                        updateMonitorSSLDetails(monitor.id, sslDetails);

                        // Trigger alert if expiring soon
                        checkAndAlert(monitor, 'SSL', expiryDate);
                    }
                } catch (parseErr) {
                    logger.warn(`[ExpiryWorker] SSL parse error for ${hostname}: ${parseErr.message}`);
                }

                socket.end();
                resolve();
            });

            socket.on('error', (err) => {
                logger.warn(`[ExpiryWorker] SSL check failed for ${hostname}: ${err.message}`);
                // Record the SSL error so the dashboard can display it
                updateMonitorSSLError(monitor.id, err.message);
                socket.destroy();
                resolve();
            });

            socket.setTimeout(10000, () => {
                updateMonitorSSLError(monitor.id, 'SSL connection timed out (10s)');
                socket.destroy();
                resolve();
            });
        } catch (e) {
            resolve();
        }
    });
}

/**
 * Format issuer/subject object into a readable string.
 * e.g. { O: "Let's Encrypt", CN: "R3" } → "CN=R3, O=Let's Encrypt"
 */
function formatCertField(field) {
    if (!field) return null;
    if (typeof field === 'string') return field;
    const parts = [];
    if (field.CN) parts.push(`CN=${field.CN}`);
    if (field.O)  parts.push(`O=${field.O}`);
    if (field.OU) parts.push(`OU=${field.OU}`);
    if (field.C)  parts.push(`C=${field.C}`);
    if (field.ST) parts.push(`ST=${field.ST}`);
    if (field.L)  parts.push(`L=${field.L}`);
    return parts.length > 0 ? parts.join(', ') : JSON.stringify(field);
}

/**
 * Extract Subject Alternative Names from the subjectaltname string.
 * Input:  "DNS:example.com, DNS:*.example.com, DNS:www.example.com"
 * Output: JSON string array: '["example.com","*.example.com","www.example.com"]'
 */
function extractSANs(subjectaltname) {
    if (!subjectaltname) return null;
    const sans = subjectaltname
        .split(',')
        .map(s => s.trim().replace(/^DNS:/i, ''))
        .filter(Boolean);
    return JSON.stringify(sans);
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

async function updateMonitorSSLDetails(monitorId, details) {
    try {
        await pool.query(
            `UPDATE monitors SET 
                ssl_expiry = $1, ssl_valid_from = $2, ssl_issuer = $3, ssl_subject = $4,
                ssl_fingerprint = $5, ssl_sans = $6, ssl_protocol = $7, ssl_cipher = $8,
                ssl_is_valid = $9, ssl_error = $10, last_ssl_check = NOW()
             WHERE id = $11`,
            [
                details.ssl_expiry, details.ssl_valid_from, details.ssl_issuer, details.ssl_subject,
                details.ssl_fingerprint, details.ssl_sans, details.ssl_protocol, details.ssl_cipher,
                details.ssl_is_valid, details.ssl_error, monitorId
            ]
        );
    } catch (err) {
        logger.error(`[ExpiryWorker] Failed to update SSL details for monitor ${monitorId}: ${err.message}`);
    }
}

async function updateMonitorSSLError(monitorId, errorMessage) {
    try {
        await pool.query(
            `UPDATE monitors SET ssl_is_valid = false, ssl_error = $1, last_ssl_check = NOW() WHERE id = $2`,
            [errorMessage, monitorId]
        );
    } catch (err) {
        logger.error(`[ExpiryWorker] Failed to update SSL error for monitor ${monitorId}: ${err.message}`);
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
    const diffMs = expiryDate.getTime() - Date.now();
    const daysRemaining = diffMs > 0 ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : Math.floor(diffMs / (1000 * 60 * 60 * 24));

    // Find the appropriate alert threshold
    for (const threshold of EXPIRY_ALERT_DAYS) {
        if (daysRemaining <= threshold && daysRemaining >= 0) {
            logger.info(`[ExpiryWorker] Dispatching ${label} expiry alert for ${monitor.name} (${daysRemaining} days remaining, threshold: ${threshold}d)`);
            
            await alertQueue.add(
                `expiry-alert-${monitor.id}-${label.toLowerCase()}-${threshold}d`,
                {
                    monitorId: monitor.id,
                    target: monitor.target,
                    previousStatus: 'up',
                    newStatus: 'warning',
                    errorMessage: `${label} Certificate expiring in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} (Expiry: ${expiryDate.toDateString()})`,
                    timestamp: new Date().toISOString()
                },
                { 
                    removeOnComplete: true,
                    // Deduplicate: only fire once per threshold per day
                    jobId: `expiry-${monitor.id}-${label.toLowerCase()}-${threshold}d-${new Date().toISOString().split('T')[0]}`
                }
            );
            break; // Only send the most urgent alert level
        }
    }
}

logger.info('[ExpiryWorker] Initialized and waiting for expiry-checks queue...');

module.exports = expiryWorker;
