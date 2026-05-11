const pool = require('../../../core/db/pool');
const { encryptString, decryptString } = require('../../../core/utils/cryptoUtils');
const ProviderFactory = require('../../../core/storage/providerFactory');
const { archiveQueue } = require('../../../core/queue/setup');

/**
 * Get user archive settings
 */
async function getSettings(req, reply) {
    const userId = req.user.id;
    const res = await pool.query('SELECT * FROM archive_settings WHERE user_id = $1', [userId]);
    
    if (res.rowCount === 0) {
        return reply.send({
            provider: 's3',
            retention_days: 30,
            auto_archive: false,
            compression_enabled: true,
            encryption_enabled: false,
            has_credentials: false
        });
    }

    const settings = res.rows[0];
    delete settings.user_id;
    
    // Don't send credentials back, just indicate if they exist
    settings.has_credentials = !!settings.credentials_encrypted;
    delete settings.credentials_encrypted;
    delete settings.encryption_key_encrypted;

    return reply.send(settings);
}

/**
 * Update user archive settings
 */
async function updateSettings(req, reply) {
    const userId = req.user.id;
    const {
        provider,
        credentials, // JSON object from client
        retention_days,
        auto_archive,
        compression_enabled,
        encryption_enabled,
        encryption_key
    } = req.body;

    // Check if we need to update credentials
    let queryArgs = [userId, provider, retention_days, auto_archive, compression_enabled, encryption_enabled];
    let queryStr = `
        INSERT INTO archive_settings (user_id, provider, retention_days, auto_archive, compression_enabled, encryption_enabled, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        retention_days = EXCLUDED.retention_days,
        auto_archive = EXCLUDED.auto_archive,
        compression_enabled = EXCLUDED.compression_enabled,
        encryption_enabled = EXCLUDED.encryption_enabled,
        updated_at = NOW()
        RETURNING *;
    `;

    if (credentials && Object.keys(credentials).length > 0) {
        const encryptedCreds = encryptString(JSON.stringify(credentials));
        let encryptedKey = null;
        if (encryption_key) {
            encryptedKey = encryptString(encryption_key);
        }

        queryArgs = [userId, provider, encryptedCreds, retention_days, auto_archive, compression_enabled, encryption_enabled, encryptedKey];
        queryStr = `
            INSERT INTO archive_settings (user_id, provider, credentials_encrypted, retention_days, auto_archive, compression_enabled, encryption_enabled, encryption_key_encrypted, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
            provider = EXCLUDED.provider,
            credentials_encrypted = EXCLUDED.credentials_encrypted,
            retention_days = EXCLUDED.retention_days,
            auto_archive = EXCLUDED.auto_archive,
            compression_enabled = EXCLUDED.compression_enabled,
            encryption_enabled = EXCLUDED.encryption_enabled,
            encryption_key_encrypted = EXCLUDED.encryption_key_encrypted,
            updated_at = NOW()
            RETURNING *;
        `;
    }

    const res = await pool.query(queryStr, queryArgs);
    const settings = res.rows[0];
    settings.has_credentials = !!settings.credentials_encrypted;
    delete settings.credentials_encrypted;
    delete settings.encryption_key_encrypted;

    return reply.send({ success: true, settings });
}

/**
 * Get archive history
 */
async function getHistory(req, reply) {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const countRes = await pool.query('SELECT COUNT(*) FROM archives WHERE user_id = $1', [userId]);
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await pool.query(
        'SELECT id, data_type, file_name, provider, file_size_bytes, record_count, status, created_at, verified_at FROM archives WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset]
    );

    return reply.send({
        archives: res.rows,
        total,
        page,
        totalPages: Math.ceil(total / limit)
    });
}

/**
 * Generate download link for an archive
 */
async function downloadArchive(req, reply) {
    const userId = req.user.id;
    const archiveId = req.params.id;

    const res = await pool.query('SELECT * FROM archives WHERE id = $1 AND user_id = $2', [archiveId, userId]);
    if (res.rowCount === 0) {
        return reply.status(404).send({ error: 'Archive not found' });
    }

    const archive = res.rows[0];
    if (archive.status !== 'verified' && archive.status !== 'uploaded') {
        return reply.status(400).send({ error: 'Archive is not ready for download' });
    }

    const settingsRes = await pool.query('SELECT credentials_encrypted FROM archive_settings WHERE user_id = $1', [userId]);
    if (settingsRes.rowCount === 0) {
        return reply.status(400).send({ error: 'Storage credentials not found' });
    }

    try {
        const provider = ProviderFactory.createProvider(archive.provider, settingsRes.rows[0].credentials_encrypted);
        const url = await provider.getSignedUrl(archive.provider_file_id, 3600); // 1 hour link
        return reply.send({ url });
    } catch (err) {
        req.log.error(`[Archive Download] Error generating link: ${err.message}`);
        return reply.status(500).send({ error: 'Failed to generate download link. Verify your storage credentials.' });
    }
}

/**
 * Trigger manual archive
 */
async function triggerManualArchive(req, reply) {
    const userId = req.user.id;
    const { data_type, days_old } = req.body;

    if (!['monitor_metrics', 'agent_metrics'].includes(data_type)) {
        return reply.status(400).send({ error: 'Invalid data_type' });
    }

    const settingsRes = await pool.query('SELECT * FROM archive_settings WHERE user_id = $1', [userId]);
    if (settingsRes.rowCount === 0 || !settingsRes.rows[0].credentials_encrypted) {
        return reply.status(400).send({ error: 'Storage credentials not configured' });
    }

    const settings = settingsRes.rows[0];
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - (days_old || settings.retention_days || 30));

    const archRes = await pool.query(
        `INSERT INTO archives (user_id, data_type, provider, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, data_type, settings.provider, 'pending']
    );

    await archiveQueue.add(`archive-${data_type}-manual`, {
        archiveId: archRes.rows[0].id,
        userId,
        dataType: data_type,
        settings,
        dateThreshold: thresholdDate
    });

    return reply.send({ success: true, message: 'Archival queued successfully', archiveId: archRes.rows[0].id });
}

module.exports = {
    getSettings,
    updateSettings,
    getHistory,
    downloadArchive,
    triggerManualArchive
};
