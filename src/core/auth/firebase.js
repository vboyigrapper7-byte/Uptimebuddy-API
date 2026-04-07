const admin = require('firebase-admin');
const path = require('path');

// Load the Service Account Key JSON
const serviceAccount = require(path.resolve(__dirname, '../../../serviceAccountKey.json'));

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase Admin] Initialized successfully.');
}

module.exports = admin;
