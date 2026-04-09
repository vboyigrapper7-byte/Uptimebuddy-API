/**
 * UptimeBuddy Authentication Middleware
 * Enforces Access Token validation via Firebase Admin.
 */

const admin = require('../../core/auth/firebase');
const { validateApiKey } = require('./service');

/**
 * Standard Auth Guard: Validates Firebase ID Token
 */
async function requireAuth(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        let res;
        try {
            res = await request.server.db.query(
                'SELECT id, email, role, tier FROM users WHERE email = $1',
                [decodedToken.email]
            );
        } catch (dbErr) {
            request.log.error('Database query failed during auth:', dbErr.message);
            return reply.status(500).send({ error: 'Internal database error during authentication' });
        }

        // Auto-provision PostgreSQL DB user if they authenticated via Firebase but don't exist locally
        if (res.rows.length === 0) {
            try {
                const crypto = require('crypto');
                const placeholderHash = crypto.randomBytes(32).toString('hex');
                res = await request.server.db.query(
                    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, tier',
                    [decodedToken.email, placeholderHash, 'customer']
                );
            } catch (insertErr) {
                request.log.error('Failed to auto-provision user:', insertErr.message);
                return reply.status(500).send({ error: 'Failed to create user account locally' });
            }
        }

        request.user = res.rows[0];
    } catch (err) {
        request.log.error(`Auth failed: ${err.message}`);
        return reply.status(401).send({ error: 'Session expired or invalid token' });
    }
}

/**
 * Role Guard: Ensures user has required role (e.g. 'admin')
 */
function requireRole(role) {
    return async (request, reply) => {
        if (!request.user || request.user.role !== role) {
            return reply.status(403).send({ error: `Forbidden: Requires ${role} permissions` });
        }
    };
}

/**
 * Agent Auth Guard: Validates X-API-KEY header
 */
async function requireApiKey(request, reply) {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey) {
        return reply.status(401).send({ error: 'Missing API Key' });
    }

    const user = await validateApiKey(request.server.db, apiKey);
    if (!user) {
        return reply.status(401).send({ error: 'Invalid or revoked API Key' });
    }
    // Attach agent info to request
    request.user = user;
}

module.exports = { requireAuth, requireRole, requireApiKey };
