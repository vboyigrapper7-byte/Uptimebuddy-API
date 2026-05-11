const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
// Ensure a global encryption key exists, fall back to a dummy one for dev if missing
const GLOBAL_SECRET = process.env.ENCRYPTION_SECRET || 'default_dev_secret_key_32_bytes_';
if (Buffer.from(GLOBAL_SECRET).length !== 32) {
    console.warn('[Crypto] ENCRYPTION_SECRET must be exactly 32 bytes for aes-256-gcm');
}

/**
 * Encrypt string (useful for credentials and DB rows)
 */
function encryptString(text, secret = GLOBAL_SECRET) {
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(secret).slice(0, 32);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt string
 */
function decryptString(encryptedData, secret = GLOBAL_SECRET) {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = Buffer.from(parts[2], 'hex');
    const key = Buffer.from(secret).slice(0, 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

/**
 * Encrypt a buffer (useful for file streams/buffers)
 */
function encryptBuffer(buffer, secret = GLOBAL_SECRET) {
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(secret).slice(0, 32);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Format: IV(12) + AuthTag(16) + EncryptedData
    return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer
 */
function decryptBuffer(buffer, secret = GLOBAL_SECRET) {
    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const encryptedData = buffer.subarray(28);
    const key = Buffer.from(secret).slice(0, 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

module.exports = {
    encryptString,
    decryptString,
    encryptBuffer,
    decryptBuffer
};
