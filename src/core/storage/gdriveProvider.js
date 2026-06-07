const axios = require('axios');
const StorageProvider = require('./storageProvider');

class GDriveProvider extends StorageProvider {
    constructor(credentials) {
        super(credentials);
        // credentials should have: accessToken
        // In a real OAuth flow, this should also handle refreshTokens.
        this.accessToken = credentials.accessToken;
        this.folderId = credentials.folderId; // Optional destination folder
    }

    async upload(fileName, dataBuffer, mimeType = 'application/json') {
        const metadata = {
            name: fileName,
            mimeType: mimeType
        };
        if (this.folderId) {
            metadata.parents = [this.folderId];
        }

        const boundary = 'foo_bar_baz';
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelimiter = `\r\n--${boundary}--`;

        const multipartRequestBody = Buffer.concat([
            Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + delimiter + 'Content-Type: ' + mimeType + '\r\n\r\n'),
            dataBuffer,
            Buffer.from(closeDelimiter)
        ]);

        const response = await axios.post(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            multipartRequestBody,
            {
                headers: {
                    'Content-Type': `multipart/related; boundary=${boundary}`,
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        return {
            fileId: response.data.id,
            url: `https://drive.google.com/file/d/${response.data.id}/view`,
            checksum: 'n/a'
        };
    }

    async download(fileId) {
        const response = await axios.get(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
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
        // GDrive files can be downloaded directly if the user has access.
        // We will just return the web view link or download link.
        // Note: For public links, permissions must be set. We assume the user downloads via our API using download().
        return `https://drive.google.com/file/d/${fileId}/view`;
    }

    async verify(fileId) {
        try {
            await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    async testConnection() {
        await axios.get('https://www.googleapis.com/drive/v3/files?pageSize=1', {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            }
        });
        return true;
    }
}

module.exports = GDriveProvider;
