const axios = require('axios');
const StorageProvider = require('./storageProvider');

class DropboxProvider extends StorageProvider {
    constructor(credentials) {
        super(credentials);
        this.accessToken = credentials.accessToken;
    }

    async upload(fileName, dataBuffer, mimeType = 'application/json') {
        const response = await axios.post(
            'https://content.dropboxapi.com/2/files/upload',
            dataBuffer,
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify({
                        path: `/${fileName}`,
                        mode: 'add',
                        autorename: true,
                        mute: false,
                        strict_conflict: false
                    }),
                    'Content-Type': 'application/octet-stream'
                }
            }
        );

        return {
            fileId: response.data.id,
            url: `https://www.dropbox.com/home?preview=${encodeURIComponent(response.data.name)}`,
            checksum: response.data.content_hash
        };
    }

    async download(fileId) {
        const response = await axios.post(
            'https://content.dropboxapi.com/2/files/download',
            null,
            {
                responseType: 'arraybuffer',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify({
                        path: fileId // id:xxxxx format works here
                    })
                }
            }
        );
        return Buffer.from(response.data);
    }

    async getSignedUrl(fileId, expiresInSeconds = 3600) {
        const response = await axios.post(
            'https://api.dropboxapi.com/2/files/get_temporary_link',
            { path: fileId },
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.link;
    }

    async verify(fileId) {
        try {
            await axios.post(
                'https://api.dropboxapi.com/2/files/get_metadata',
                { path: fileId },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    async testConnection() {
        await axios.post(
            'https://api.dropboxapi.com/2/files/list_folder',
            { path: '', limit: 1 },
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return true;
    }
}

module.exports = DropboxProvider;
