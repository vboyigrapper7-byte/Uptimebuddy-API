/**
 * UptimeBuddy Authentication Controller
 * Refactored for Firebase Auth Integration.
 */

const { z } = require('zod');
const { createUser, generateApiKey } = require('./service');
const admin = require('../../core/auth/firebase');
const crypto = require('crypto');

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

module.exports = { register, createApiKey };
