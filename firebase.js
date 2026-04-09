const admin = require('firebase-admin');
const path = require('path');

let serviceAccount;

// 1. Load from ENV (Render / Production)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

        // 🔥 FIX: Handle private key formatting
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        console.log('[Firebase Admin] Loaded from ENV');
    } catch (err) {
        console.error('[Firebase Admin] ENV parse error:', err.message);
    }
}

// 2. Fallback (Local)
if (!serviceAccount) {
    try {
        const keyPath = path.resolve(__dirname, '../../../serviceAccountKey.json');
        serviceAccount = require(keyPath);
        console.log('[Firebase Admin] Loaded from local file');
    } catch (err) {
        console.warn('[Firebase Admin] No local service account found');
    }
}

// 3. Initialize
if (serviceAccount && !admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('[Firebase Admin] Initialized');
    } catch (err) {
        console.error('[Firebase Admin] Init error:', err.message);
    }
} else if (!serviceAccount) {
    console.error('[Firebase Admin] CRITICAL: No credentials');
}

module.exports = admin;