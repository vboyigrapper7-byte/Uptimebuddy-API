/**
 * Monitor Hub Authentication Tokens Utility
 */

/**
 * Generate Access Token (Short-lived: 15m)
 * Contains minimal user info (id, role, tier)
 */
function generateAccessToken(fastify, user) {
    return fastify.jwt.sign(
        { id: user.id, email: user.email, role: user.role, tier: user.tier },
        { expiresIn: '15m' }
    );
}

/**
 * Generate Refresh Token (Long-lived: 7d)
 * Used to request new Access Tokens
 */
function generateRefreshToken(fastify, user) {
    return fastify.jwt.sign(
        { id: user.id },
        { expiresIn: '7d' }
    );
}

module.exports = { generateAccessToken, generateRefreshToken };
