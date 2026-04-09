const admin = require('firebase-admin');
const path = require('path');

let serviceAccount;

// 1. Try to load from environment variable (Best for Render/Production)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('[Firebase Admin] Loaded credentials from FIREBASE_SERVICE_ACCOUNT env var.');
    } catch (err) {
        console.error('[Firebase Admin] Error parsing FIREBASE_SERVICE_ACCOUNT env var:', err.message);
    }
}

// 2. Fallback to local file (For Local Development)
if (!serviceAccount) {
    try {
        const keyPath = path.resolve(__dirname, '../../../serviceAccountKey.json');
        serviceAccount = require(keyPath);
        console.log('[Firebase Admin] Loaded credentials from local serviceAccountKey.json.');
    } catch (err) {
        console.warn('[Firebase Admin] Local serviceAccountKey.json not found.');
    }
}

if (serviceAccount) {
    if (!admin.apps.length) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('[Firebase Admin] Initialized successfully.');
        } catch (err) {
            console.error('[Firebase Admin] Initialization error:', err.message);
        }
    }
} else {
    console.error('[Firebase Admin] CRITICAL: No service account credentials found. Auth will fail.');
}

module.exports = admin;
