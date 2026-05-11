const axios = require('axios');
const StorageProvider = require('./storageProvider');

class OneDriveProvider extends StorageProvider {
    constructor(credentials) {
        super(credentials);
        this.accessToken = credentials.accessToken;
    }

    async upload(fileName, dataBuffer, mimeType = 'application/json') {
        // Simple upload up to 4MB, use createUploadSession for larger files in production
        // For now, assume small batches or use standard put
        const response = await axios.put(
            `https://graph.microsoft.com/v1.0/me/drive/root:/MonitorHub/${fileName}:/content`,
            dataBuffer,
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': mimeType
                }
            }
        );

        return {
            fileId: response.data.id,
            url: response.data.webUrl,
            checksum: 'n/a'
        };
    }

    async download(fileId) {
        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`,
            {
                responseType: 'arraybuffer',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );
        return Buffer.from(response.data);
    }

    async getSignedUrl(fileId, expiresInSeconds = 3600) {
        // Note: MS Graph doesn't directly offer standard signed URLs like S3,
        // Instead, we can create a temporary sharing link or just return download link.
        // We will create a read-only view link
        try {
            const response = await axios.post(
                `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/createLink`,
                { type: 'view', scope: 'anonymous' },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return response.data.link.webUrl;
        } catch (error) {
            console.error('OneDrive createLink error:', error.message);
            throw error;
        }
    }

    async verify(fileId) {
        try {
            await axios.get(
                `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = OneDriveProvider;
