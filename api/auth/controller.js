/**
 * Monitor Hub Authentication Controller
 * Refactored for Firebase Auth Integration.
 */

const { z } = require('zod');
const { createUser, generateApiKey } = require('./service');
const admin = require('../../core/auth/firebase');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const otpService = require('./services/otpService');
const emailService = require('./services/emailService');

const RegisterSchema = z.object({
    email: z.string().email(),
    uid: z.string() // Firebase UID
});

const register = async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid payload' });
    }

    try {
        // Verify Firebase UID actually exists in Firebase to prevent spoofing
        const firebaseUser = await admin.auth().getUser(parsed.data.uid);
        if (firebaseUser.email !== parsed.data.email) {
            return reply.status(403).send({ error: 'Email mismatch' });
        }

        // We generate a dummy password since Postgres requires password_hash 
        //, but it's unused now because Firebase handles auth.
        const dummyPassword = crypto.randomBytes(32).toString('hex');
        
        const user = await createUser(request.server.db, { 
            email: parsed.data.email, 
            password: dummyPassword 
        });

        return reply.status(201).send({
            message: 'User synchronized successfully',
            user
        });
    } catch (err) {
        // If email already exists in our DB, that's fine for Firebase logins (they just registered or logged in)
        if (err.code === '23505') {
            return reply.send({ message: 'User already synced' }); 
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'Internal server error while syncing user' });
    }
};

const createApiKey = async (request, reply) => {
    try {
        const key = await generateApiKey(request.server.db, request.user.id);
        return reply.send({
            message: 'API Key generated. Copy it now, it will NOT be shown again.',
            apiKey: key
        });
    } catch (err) {
        return reply.status(500).send({ error: 'Failed to generate API Key' });
    }
};

const updateProfile = async (request, reply) => {
    const { name, status_slug } = request.body || {};
    
    if (name === undefined && status_slug === undefined) {
        return reply.status(400).send({ error: 'Nothing to update' });
    }

    // Basic slug validation
    if (status_slug && !/^[a-z0-9-]+$/.test(status_slug)) {
        return reply.status(400).send({ error: 'Status slug must be alphanumeric with hyphens only' });
    }

    try {
        const res = await request.server.db.query(
            `UPDATE users SET 
               name = COALESCE($1, name),
               status_slug = COALESCE($2, status_slug)
             WHERE id = $3 RETURNING id, email, name, status_slug, tier, role, created_at`,
            [name?.trim() || null, status_slug?.toLowerCase() || null, request.user.id]
        );

        if (res.rows.length === 0) {
            return reply.status(404).send({ error: 'User not found' });
        }

        return reply.send({ message: 'Profile updated successfully', user: res.rows[0] });
    } catch (err) {
        request.log.error(err, 'Failed to update profile');
        return reply.status(500).send({ error: 'Internal server error while updating profile' });
    }
};

const sendOTP = async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
        return reply.status(400).send({ error: 'Email and password are required' });
    }

    try {
        // 1. Check if user already exists
        const existing = await request.server.db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return reply.status(400).send({ error: 'Account already exists. Please login.' });
        }

        // 2. Check cooldown
        const canSend = await otpService.checkCooldown(request.server.db, email);
        if (!canSend) {
            return reply.status(429).send({ error: 'Please wait 60 seconds before requesting a new code.' });
        }

        // 3. Hash password IMMEDIATELY
        const hashedPassword = await bcrypt.hash(password, 12);

        // 4. Generate & Store OTP
        const otp = otpService.generateOTP();
        await otpService.storeOTP(request.server.db, {
            email,
            otp,
            hashed_password: hashedPassword
        });

        // 5. Send Email via Resend
        const sent = await emailService.sendOTPEmail(email, otp);
        if (!sent.success) {
            return reply.status(500).send({ error: 'Failed to send verification email' });
        }

        return reply.send({ message: 'Verification code sent to your email.' });
    } catch (err) {
        request.log.error({ err, email, stack: err.stack }, 'Signup OTP send failure');
        return reply.status(500).send({ 
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? err.message : undefined 
        });
    }
};

const verifyOTP = async (request, reply) => {
    const { email, otp, password } = request.body;
    if (!email || !otp) {
        return reply.status(400).send({ error: 'Email and verification code are required' });
    }

    try {
        const verification = await otpService.verifyOTP(request.server.db, { email, otp });
        
        if (!verification.valid) {
            return reply.status(400).send({ error: verification.error });
        }

        // --- Firebase Strategy Sync ---
        // 1. Check if user exists in Firebase, if not create them
        let firebaseUser;
        try {
            firebaseUser = await admin.auth().getUserByEmail(email);
        } catch (err) {
            if (err.code === 'auth/user-not-found') {
                if (!password) {
                    return reply.status(400).send({ error: 'Password is required to complete registration' });
                }
                firebaseUser = await admin.auth().createUser({
                    email,
                    password,
                    emailVerified: true
                });
            } else {
                throw err;
            }
        }

        // 2. Sync with local Postgres
        const user = await createUser(request.server.db, {
            email,
            passwordHash: verification.hashed_password
        });

        // 3. Cleanup
        await otpService.deleteOTP(request.server.db, email);

        // 4. Generate Firebase Custom Token for the user
        const customToken = await admin.auth().createCustomToken(firebaseUser.uid);

        return reply.status(201).send({
            message: 'Email verified and account created successfully!',
            user,
            customToken
        });
    } catch (err) {
        request.log.error({ err, email, stack: err.stack }, 'Signup OTP verification failure');
        return reply.status(500).send({ error: 'Verification failed' });
    }
};

const resendOTP = async (request, reply) => {
    const { email } = request.body;
    if (!email) return reply.status(400).send({ error: 'Email is required' });

    try {
        const canSend = await otpService.checkCooldown(request.server.db, email);
        if (!canSend) {
            return reply.status(429).send({ error: 'Please wait 60 seconds before resending.' });
        }

        const res = await request.server.db.query('SELECT hashed_password FROM otps WHERE email = $1', [email]);
        if (res.rows.length === 0) {
            return reply.status(400).send({ error: 'No signup in progress for this email.' });
        }

        const otp = otpService.generateOTP();
        await otpService.storeOTP(request.server.db, {
            email,
            otp,
            hashed_password: res.rows[0].hashed_password
        });

        await emailService.sendOTPEmail(email, otp);
        
        return reply.send({ message: 'New verification code sent.' });
    } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'Failed to resend code' });
    }
};

module.exports = { register, createApiKey, updateProfile, sendOTP, verifyOTP, resendOTP };

