/**
 * Admin Authentication Middleware
 * Validates admin token.
 */
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'monitorhub_admin_secret_key_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Rajkumarrathi@gmail.com';

// Stateless token generation for reliability across process restarts
function generateAdminToken() {
    return crypto.createHmac('sha256', ADMIN_SECRET).update(ADMIN_PASSWORD).digest('hex');
}

function revokeAdminToken(token) {
    // In a fully stateless setup with a single token, we can't truly revoke it without changing the password.
    // This is acceptable for a single-admin upgrade task.
}

async function requireAdminAuth(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.split('Bearer ')[1];

    const expectedToken = generateAdminToken();

    if (token !== expectedToken) {
        return reply.status(401).send({ error: 'Invalid or expired admin token' });
    }

    request.isAdmin = true;
}

module.exports = {
    requireAdminAuth,
    generateAdminToken,
    revokeAdminToken,
    ADMIN_PASSWORD
};
