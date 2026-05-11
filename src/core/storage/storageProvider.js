/**
 * Base interface for Storage Providers
 */
class StorageProvider {
    constructor(credentials) {
        this.credentials = credentials;
    }

    /**
     * Uploads a buffer or stream to the storage provider
     * @param {string} fileName 
     * @param {Buffer} dataBuffer 
     * @param {string} mimeType
     * @returns {Promise<{ fileId: string, url: string, checksum: string }>}
     */
    async upload(fileName, dataBuffer, mimeType = 'application/json') {
        throw new Error('Method not implemented.');
    }

    /**
     * Downloads a file from the storage provider
     * @param {string} fileId 
     * @returns {Promise<Buffer>}
     */
    async download(fileId) {
        throw new Error('Method not implemented.');
    }

    /**
     * Generates a temporary signed URL for direct download
     * @param {string} fileId 
     * @param {number} expiresInSeconds 
     * @returns {Promise<string>}
     */
    async getSignedUrl(fileId, expiresInSeconds = 3600) {
        throw new Error('Method not implemented.');
    }

    /**
     * Verifies if a file exists
     * @param {string} fileId 
     * @returns {Promise<boolean>}
     */
    async verify(fileId) {
        throw new Error('Method not implemented.');
    }
}

module.exports = StorageProvider;
