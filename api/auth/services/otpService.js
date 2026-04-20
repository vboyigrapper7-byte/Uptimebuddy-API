/**
 * OTP Service
 * Handles 6-digit code generation, PostgreSQL storage, and verification logic.
 */

const bcrypt = require('bcrypt');

/**
 * Generate a random 6-digit numeric OTP
 */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Store or Update OTP for an email
 */
async function storeOTP(db, { email, otp, hashed_password }) {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    
    // Using ON CONFLICT to handle resends for the same email
    const query = `
        INSERT INTO otps (email, otp, hashed_password, expires_at, attempts, last_sent_at)
        VALUES ($1, $2, $3, $4, 0, NOW())
        ON CONFLICT (email) DO UPDATE SET
            otp = EXCLUDED.otp,
            hashed_password = EXCLUDED.hashed_password,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            last_sent_at = NOW();
    `;
    
    await db.query(query, [email, otp, hashed_password, expiresAt]);
}

/**
 * Verify OTP
 * Returns { valid: boolean, hashed_password?: string, error?: string }
 */
async function verifyOTP(db, { email, otp }) {
    const res = await db.query(
        'SELECT otp, hashed_password, expires_at, attempts FROM otps WHERE email = $1',
        [email]
    );
    
    const record = res.rows[0];
    if (!record) {
        return { valid: false, error: 'No OTP found for this email' };
    }

    // Check attempts
    if (record.attempts >= 5) {
        return { valid: false, error: 'Max attempts reached. Please request a new code.' };
    }

    // Check expiry
    if (new Date() > record.expires_at) {
        return { valid: false, error: 'OTP has expired' };
    }

    // Check match
    if (record.otp !== otp) {
        // Increment attempts
        await db.query('UPDATE otps SET attempts = attempts + 1 WHERE email = $1', [email]);
        return { valid: false, error: 'Invalid OTP' };
    }

    return { valid: true, hashed_password: record.hashed_password };
}

/**
 * Check if resend cooldown is active (60s)
 */
async function checkCooldown(db, email) {
    const res = await db.query('SELECT last_sent_at FROM otps WHERE email = $1', [email]);
    if (res.rows.length === 0) return true;

    const lastSent = new Date(res.rows[0].last_sent_at);
    const secondsPassed = (Date.now() - lastSent.getTime()) / 1000;
    
    return secondsPassed >= 60;
}

/**
 * Delete OTP record after successful verification
 */
async function deleteOTP(db, email) {
    await db.query('DELETE FROM otps WHERE email = $1', [email]);
}

module.exports = {
    generateOTP,
    storeOTP,
    verifyOTP,
    checkCooldown,
    deleteOTP
};
