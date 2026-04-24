const dns = require('dns');
const http = require('http');
const https = require('https');

/**
 * SSRF Protection Utility
 * Prevents requests to internal/private network ranges and mitigates DNS rebinding.
 */

const PRIVATE_RANGES = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^fc00:/, // IPv6 Unique Local Address
    /^fe80:/  // IPv6 Link Local Address
];

/**
 * Validates if an IP address is within a restricted private range.
 */
function isPrivateIp(ip) {
    if (!ip) return true;
    return PRIVATE_RANGES.some(re => re.test(ip));
}

/**
 * Custom DNS lookup function that filters out private IPs.
 * This is the most robust way to prevent DNS rebinding in Node.js.
 */
const safeLookup = (hostname, options, callback) => {
    // If 'options' is a function, it means it's the callback (Node.js internal variability)
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' ? options : {};

    dns.lookup(hostname, opts, (err, address, family) => {
        if (err) return cb(err);
        
        // Handle array of addresses (if all: true)
        const addresses = Array.isArray(address) ? address : [{ address, family }];
        
        for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
                return cb(new Error(`Security Restriction: Access to private network range (${addr.address}) is forbidden`));
            }
        }
        
        cb(null, address, family);
    });
};

const safeHttpAgent = new http.Agent({ lookup: safeLookup, keepAlive: true });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: true });

/**
 * Returns axios configuration with safe agents
 */
function getSafeAxiosConfig() {
    return {
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
        // Ensure we don't follow redirects to private IPs
        beforeRedirect: (options) => {
            // This is a double-check, as the agent's lookup will also catch this
            if (options.hostname && isPrivateIp(options.hostname)) {
                throw new Error('Security Restriction: Redirect to private network forbidden');
            }
        }
    };
}

module.exports = {
    isPrivateIp,
    safeLookup,
    safeHttpAgent,
    safeHttpsAgent,
    getSafeAxiosConfig
};
