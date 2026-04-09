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
                let serviceAccountData = process.env.FIREBASE_SERVICE_ACCOUNT;
                // If the string starts/ends with quotes, it might have been passed incorrectly
                if (serviceAccountData.startsWith('"') && serviceAccountData.endsWith('"')) {
                    serviceAccountData = serviceAccountData.slice(1, -1);
                }
                
                const cert = JSON.parse(serviceAccountData);
                
                // 🔥 FIX: Handle private key formatting (essential for Render env vars)
                if (cert.private_key) {
                    cert.private_key = cert.private_key.replace(/\\n/g, '\n');
                }

                admin.initializeApp({
                    credential: admin.credential.cert(cert)
                });
                console.log('[Firebase Admin] Initialized successfully using FIREBASE_SERVICE_ACCOUNT env var.');
            } catch (err) {
                console.error('[Firebase Admin] Error parsing FIREBASE_SERVICE_ACCOUNT env var:', err.message);
                // Try initializing without cert as last resort (e.g. if ADC is configured)
                try { admin.initializeApp(); } catch (e) { console.error('[Firebase Admin] Fallback init failed:', e.message); }
            }
        } else {
            console.error('[Firebase Admin] CRITICAL: No credentials found. Initializing without credentials (auth will fail).');
            admin.initializeApp();
        }
    }
}

module.exports = admin;
