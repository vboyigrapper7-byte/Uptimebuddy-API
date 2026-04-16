/**
 * Monitor Hub Authentication Service Layer
 * Direct interaction with the database for all auth-related tasks.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');

/**
 * Register User
 * Hashes password and user defaults.
 */
async function createUser(db, { email, password, role = 'customer' }) {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, tier',
        [email, passwordHash, role]
    );
    return result.rows[0];
}

/**
 * Validate User Credentials
 */
async function validateCredentials(db, email, password) {
    const res = await db.query('SELECT id, email, password_hash, role, tier FROM users WHERE email = $1', [email]);
    const user = res.rows[0];
    if (!user) return null;

    const match = await bcrypt.compare(password, user.password_hash);
    return match ? user : null;
}

/**
 * Store/Rotate Refresh Token (Hashed)
 */
async function storeRefreshToken(db, userId, token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    // Delete existing tokens if needed (for simplicity, we track multiple if multiple devices)
    await db.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [userId, tokenHash, expiresAt]
    );
}

/**
 * Verify Refresh Token
 */
async function verifyRefreshToken(db, userId, token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const res = await db.query(
        'SELECT id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()',
        [userId, tokenHash]
    );
    return res.rows.length > 0;
}

/**
 * Revoke Refresh Token (Logout)
 */
async function revokeRefreshToken(db, userId, token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2', [userId, tokenHash]);
}

/**
 * API Key System: Generate & Store Hashed Key
 * Returns original key (to be shown ONCE) and stores SHA256 in DB.
 */
async function generateApiKey(db, userId) {
    const rawKey = `ub_${crypto.randomBytes(24).toString('hex')}`;
    const hash   = crypto.createHash('sha256').update(rawKey).digest('hex');

    await db.query('UPDATE users SET api_key_hash = $1 WHERE id = $2', [hash, userId]);
    return rawKey;
}

/**
 * Validate API Key
 */
async function validateApiKey(db, apiKey) {
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const res = await db.query('SELECT id, email, role, tier FROM users WHERE api_key_hash = $1', [hash]);
    return res.rows[0] || null;
}

module.exports = {
    createUser,
    validateCredentials,
    storeRefreshToken,
    verifyRefreshToken,
    revokeRefreshToken,
    generateApiKey,
    validateApiKey
};
