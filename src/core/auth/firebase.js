const admin = require('firebase-admin');
const path = require('path');

// Load the Service Account Key JSON if available (local dev)
let serviceAccount;
try {
    serviceAccount = require(path.resolve(__dirname, '../../../serviceAccountKey.json'));
} catch (err) {
    // Expected in production (Render) where the json file is ignored
    console.log('[Firebase Admin] serviceAccountKey.json not found, relying on environment variables.');
}

if (!admin.apps.length) {
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('[Firebase Admin] Initialized successfully using local serviceAccountKey.json.');
    } else {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                const cert = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                admin.initializeApp({
                    credential: admin.credential.cert(cert)
                });
                console.log('[Firebase Admin] Initialized successfully using FIREBASE_SERVICE_ACCOUNT env var.');
            } catch (err) {
                console.error('[Firebase Admin] Error parsing FIREBASE_SERVICE_ACCOUNT env var:', err.message);
                admin.initializeApp(); // Fallback to default
            }
        } else {
            console.error('[Firebase Admin] CRITICAL: No credentials found. Initializing without credentials (auth will fail).');
            admin.initializeApp();
        }
    }
}

module.exports = admin;
