const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const StorageProvider = require('./storageProvider');

class S3Provider extends StorageProvider {
    constructor(credentials) {
        super(credentials);
        // credentials should have: accessKeyId, secretAccessKey, region, bucket, endpoint (optional)
        const config = {
            region: credentials.region || 'us-east-1',
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey
            }
        };
        
        if (credentials.endpoint) {
            config.endpoint = credentials.endpoint;
            // Needed for R2, B2, etc.
            config.forcePathStyle = true; 
        }

        this.client = new S3Client(config);
        this.bucket = credentials.bucket;
    }

    async upload(fileName, dataBuffer, mimeType = 'application/json') {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: fileName,
            Body: dataBuffer,
            ContentType: mimeType
        });

        await this.client.send(command);
        
        return {
            fileId: fileName, // In S3, Key is the fileId
            url: `s3://${this.bucket}/${fileName}`,
            checksum: 'n/a' // Let's simplify, AWS automatically checks md5 internally
        };
    }

    async download(fileId) {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: fileId
        });
        
        const response = await this.client.send(command);
        return Buffer.from(await response.Body.transformToByteArray());
    }

    async getSignedUrl(fileId, expiresInSeconds = 3600) {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: fileId
        });
        
        return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    }

    async verify(fileId) {
        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: fileId
            });
            await this.client.send(command);
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = S3Provider;
