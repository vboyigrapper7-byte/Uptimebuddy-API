/**
 * Admin Authentication Middleware
 * Upgraded to use JWT with expiration.
 */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Rajkumarrathi@gmail.com';

/**
 * Validates the admin JWT token
 */
async function requireAdminAuth(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decoded = await request.jwtVerify();
        
        if (!decoded.isAdmin) {
            return reply.status(403).send({ error: 'Access denied: Requires admin privileges' });
        }

        request.isAdmin = true;
    } catch (err) {
        request.log.error('Admin JWT verification failed:', err.message);
        return reply.status(401).send({ error: 'Invalid or expired admin session' });
    }
}

/**
 * Revoke token logic (Stub for now, as JWT is stateless)
 */
function revokeAdminToken(token) {
    // In a stateless JWT setup, we would typically use a blocklist in Redis.
    // For single-admin use, letting the token expire is sufficient.
}

module.exports = {
    requireAdminAuth,
    revokeAdminToken,
    ADMIN_PASSWORD
};

