const { Worker } = require('bullmq');
const { workerRedisConnection } = require('../core/queue/setup');
const pool = require('../core/db/pool');
const ProviderFactory = require('../core/storage/providerFactory');
const { encryptBuffer } = require('../core/utils/cryptoUtils');
const zlib = require('zlib');
const util = require('util');
const gzip = util.promisify(zlib.gzip);

async function performArchival(job) {
    const { archiveId, userId, dataType, settings, dateThreshold } = job.data;
    console.log(`[ArchiveWorker] Starting archival ${archiveId} for user ${userId} (${dataType})`);

    const client = await pool.connect();
    let rowsToArchive = [];
    
    try {
        // 1. Fetch data
        if (dataType === 'monitor_metrics') {
            const res = await client.query(
                `SELECT mm.* FROM monitor_metrics mm
                 JOIN monitors m ON mm.monitor_id = m.id
                 WHERE m.user_id = $1 AND mm.recorded_at < $2`,
                [userId, dateThreshold]
            );
            rowsToArchive = res.rows;
        } else if (dataType === 'agent_metrics') {
            const res = await client.query(
                `SELECT am.* FROM agent_metrics am
                 JOIN agents a ON am.agent_id = a.id
                 WHERE a.user_id = $1 AND am.recorded_at < $2`,
                [userId, dateThreshold]
            );
            rowsToArchive = res.rows;
        } else {
            throw new Error(`Unknown data_type: ${dataType}`);
        }

        if (rowsToArchive.length === 0) {
            console.log(`[ArchiveWorker] No data found for archive ${archiveId}. Marking completed.`);
            await client.query('UPDATE archives SET status = $1 WHERE id = $2', ['completed_empty', archiveId]);
            return;
        }

        // 2. Prepare Payload
        let payloadString = JSON.stringify(rowsToArchive);
        let payloadBuffer = Buffer.from(payloadString, 'utf8');
        let fileExtension = 'json';
        let mimeType = 'application/json';

        // 3. Compression
        if (settings.compression_enabled) {
            payloadBuffer = await gzip(payloadBuffer);
            fileExtension = 'json.gz';
            mimeType = 'application/gzip';
        }

        // 4. Encryption
        if (settings.encryption_enabled && settings.encryption_key_encrypted) {
            // Note: In production, user might supply their own key or we use platform key
            // Here we use standard platform global secret as requested by simple architecture,
            // or the user's specific key if implemented.
            payloadBuffer = encryptBuffer(payloadBuffer);
            fileExtension += '.enc';
            mimeType = 'application/octet-stream';
        }

        const fileName = `archive_${dataType}_${userId}_${Date.now()}.${fileExtension}`;

        // 5. Upload via Provider
        const provider = ProviderFactory.createProvider(settings.provider, settings.credentials_encrypted);
        const uploadResult = await provider.upload(fileName, payloadBuffer, mimeType);

        // 6. Verify Upload
        const isVerified = await provider.verify(uploadResult.fileId);
        if (!isVerified) {
            throw new Error('Upload verification failed. File not found on provider.');
        }

        // 7. Update Archive Record
        await client.query(
            `UPDATE archives 
             SET status = $1, provider_file_id = $2, checksum = $3, file_size_bytes = $4, record_count = $5, verified_at = NOW(), file_name = $6
             WHERE id = $7`,
            ['verified', uploadResult.fileId, uploadResult.checksum, payloadBuffer.length, rowsToArchive.length, fileName, archiveId]
        );

        // 8. Safely delete from primary DB precisely what was archived
        if (dataType === 'monitor_metrics') {
            const monitorIds = rowsToArchive.map(r => r.monitor_id);
            const recordedAts = rowsToArchive.map(r => r.recorded_at);
            
            // Delete in chunks of 50000 to avoid massive lock/memory spikes in Postgres
            const chunkSize = 50000;
            for (let i = 0; i < monitorIds.length; i += chunkSize) {
                const chunkMonitorIds = monitorIds.slice(i, i + chunkSize);
                const chunkRecordedAts = recordedAts.slice(i, i + chunkSize);
                await client.query(
                    `DELETE FROM monitor_metrics 
                     WHERE (monitor_id, recorded_at) IN (
                         SELECT * FROM unnest($1::int[], $2::timestamp[])
                     )`,
                    [chunkMonitorIds, chunkRecordedAts]
                );
            }
        } else if (dataType === 'agent_metrics') {
            const agentIds = rowsToArchive.map(r => r.agent_id);
            const recordedAts = rowsToArchive.map(r => r.recorded_at);
            
            const chunkSize = 50000;
            for (let i = 0; i < agentIds.length; i += chunkSize) {
                const chunkAgentIds = agentIds.slice(i, i + chunkSize);
                const chunkRecordedAts = recordedAts.slice(i, i + chunkSize);
                await client.query(
                    `DELETE FROM agent_metrics 
                     WHERE (agent_id, recorded_at) IN (
                         SELECT * FROM unnest($1::int[], $2::timestamp[])
                     )`,
                    [chunkAgentIds, chunkRecordedAts]
                );
            }
        }

        console.log(`[ArchiveWorker] Successfully archived ${rowsToArchive.length} rows for user ${userId}.`);

    } catch (err) {
        console.error(`[ArchiveWorker] Archival failed for ${archiveId}:`, err);
        await client.query('UPDATE archives SET status = $1 WHERE id = $2', ['failed', archiveId]);
        throw err; // Re-throw to trigger BullMQ retry
    } finally {
        client.release();
    }
}

const archiveWorker = new Worker(
    'archive-tasks',
    performArchival,
    { 
        connection: workerRedisConnection,
        concurrency: 2
    }
);

archiveWorker.on('completed', (job) => console.log(`[ArchiveWorker] Job ${job.id} completed.`));
archiveWorker.on('failed', (job, err) => console.error(`[ArchiveWorker] Job ${job.id} failed:`, err.message));

module.exports = { archiveWorker };
