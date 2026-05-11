const S3Provider = require('./s3Provider');
const GDriveProvider = require('./gdriveProvider');
const DropboxProvider = require('./dropboxProvider');
const OneDriveProvider = require('./onedriveProvider');
const { decryptString } = require('../utils/cryptoUtils');

class ProviderFactory {
    static createProvider(providerName, encryptedCredentialsStr) {
        let credentials;
        try {
            const decStr = decryptString(encryptedCredentialsStr);
            credentials = JSON.parse(decStr);
        } catch (err) {
            throw new Error(`Failed to decrypt credentials for provider ${providerName}: ${err.message}`);
        }

        switch (providerName.toLowerCase()) {
            case 's3':
            case 'r2':
            case 'b2':
                // All use S3-compatible API
                return new S3Provider(credentials);
            case 'gdrive':
                return new GDriveProvider(credentials);
            case 'dropbox':
                return new DropboxProvider(credentials);
            case 'onedrive':
                return new OneDriveProvider(credentials);
            default:
                throw new Error(`Unknown storage provider: ${providerName}`);
        }
    }
}

module.exports = ProviderFactory;
