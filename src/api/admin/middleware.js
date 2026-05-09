/**
 * Admin Authentication Middleware
 * Validates admin token.
 */
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'monitorhub_admin_secret_key_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Rajkumarrathi@gmail.com';

// In-memory store for admin tokens for simplicity and speed.
// In a highly distributed env, this could be Redis, but for an upgrade task, memory is safe and fast.
const adminTokens = new Set();

function generateAdminToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    return token;
}

function revokeAdminToken(token) {
    adminTokens.delete(token);
}

async function requireAdminAuth(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.split('Bearer ')[1];

    if (!adminTokens.has(token)) {
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
