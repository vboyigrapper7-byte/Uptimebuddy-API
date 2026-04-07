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
    } else {
        // Render or other environments can inject FIREBASE_SERVICE_ACCOUNT as a JSON string
        // or just use application default credentials via GOOGLE_APPLICATION_CREDENTIALS
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const cert = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(cert)
            });
        } else {
            // Uses standard ENV vars: process.env.GOOGLE_APPLICATION_CREDENTIALS
            admin.initializeApp();
        }
    }
    console.log('[Firebase Admin] Initialized successfully.');
}

module.exports = admin;
