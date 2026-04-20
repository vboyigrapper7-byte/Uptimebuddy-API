const ALLOWED_PROVIDERS = ['slack', 'discord', 'telegram', 'email'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function webhookRoutes(fastify, options) {
    const { requireAuth } = require('../auth/middleware');
    
    // All webhook routes require authentication
    fastify.addHook('onRequest', requireAuth);

    // Get all webhooks for the current user
    fastify.get('/', async (request, reply) => {
        const userId = request.user.id;
        try {
            const res = await fastify.db.query(
                'SELECT id, provider, url, created_at FROM webhooks WHERE user_id = $1 ORDER BY provider',
                [userId]
            );
            return reply.send(res.rows);
        } catch (err) {
            fastify.log.error(err, 'getWebhooks error');
            return reply.status(500).send({ error: 'Failed to fetch webhooks' });
        }
    });

    // Upsert (create or update) a webhook for a provider
    fastify.post('/', async (request, reply) => {
        const { provider, url } = request.body || {};
        const userId = request.user.id;

        if (!provider || !url) {
            return reply.status(400).send({ error: 'provider and url are required' });
        }

        if (!ALLOWED_PROVIDERS.includes(provider)) {
            return reply.status(400).send({ error: `Unsupported provider. Use: ${ALLOWED_PROVIDERS.join(', ')}` });
        }

        // URL validation + SSRF guard (Exempt Telegram/Email as they use non-URL formats)
        if (provider !== 'telegram' && provider !== 'email') {
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return reply.status(400).send({ error: 'Webhook URL must use http or https' });
                }
                if (PRIVATE_IP_RE.test(parsed.hostname)) {
                    return reply.status(400).send({ error: 'Private network URLs are not allowed' });
                }
            } catch {
                return reply.status(400).send({ error: 'Invalid webhook URL' });
            }
        } else if (provider === 'telegram') {
            // For telegram, just ensure it contains the pipe separator
            if (!url.includes('|')) {
                return reply.status(400).send({ error: 'Telegram format must be bot_token|chat_id' });
            }
        } else if (provider === 'email') {
            // For email, split by comma and validate each
            const emails = url.split(',').map(e => e.trim()).filter(e => e.length > 0);
            if (emails.length === 0) {
                return reply.status(400).send({ error: 'At least one valid email address is required' });
            }
            for (const email of emails) {
                if (!EMAIL_RE.test(email)) {
                    return reply.status(400).send({ error: `Invalid email address: ${email}` });
                }
            }
        }

        try {
            await fastify.db.query(
                `INSERT INTO webhooks (user_id, provider, url)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, provider) DO UPDATE SET url = EXCLUDED.url`,
                [userId, provider, url]
            );
            return reply.send({ success: true, message: 'Webhook saved successfully' });
        } catch (err) {
            fastify.log.error(err, 'saveWebhook error');
            return reply.status(500).send({ error: 'Failed to save webhook' });
        }
    });

    // Delete a webhook by provider
    fastify.delete('/:provider', async (request, reply) => {
        const { provider } = request.params;
        const userId = request.user.id;

        try {
            const res = await fastify.db.query(
                'DELETE FROM webhooks WHERE user_id = $1 AND provider = $2 RETURNING id',
                [userId, provider]
            );
            if (res.rowCount === 0) return reply.code(404).send({ error: 'Webhook not found' });
            return reply.send({ success: true });
        } catch (err) {
            fastify.log.error(err, 'deleteWebhook error');
            return reply.status(500).send({ error: 'Failed to delete webhook' });
        }
    });

    // Test alert for a specific provider
    fastify.post('/test/:provider', async (request, reply) => {
        const { provider } = request.params;
        const userId = request.user.id;
        const alertService = require('../../core/alerting/alertService');

        try {
            const res = await fastify.db.query(
                'SELECT url FROM webhooks WHERE user_id = $1 AND provider = $2',
                [userId, provider]
            );
            
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: `No ${provider} configuration found. Please save settings first.` });
            }

            const url = res.rows[0].url;
            const testPayload = {
                target: `Monitor Hub Health Check (Test)`,
                newStatus: 'up',
                timestamp: new Date().toISOString(),
                errorMessage: null
            };

            if (provider === 'telegram') {
                const [token, cid] = url.split('|');
                await alertService.sendTelegram(testPayload, token, cid);
            } else if (provider === 'email') {
                const emails = url.split(',').map(e => e.trim());
                for (const email of emails) {
                    await alertService.sendEmail(testPayload, email);
                }
            } else {
                const axios = require('axios');
                const p = provider === 'slack' ? alertService.getSlackPayload(testPayload) : alertService.getDiscordPayload(testPayload);
                await axios.post(url, p);
            }

            return reply.send({ success: true, message: `Test alert dispatched to ${provider}` });
        } catch (err) {
            fastify.log.error(err, 'testWebhook error');
            return reply.status(500).send({ error: `Failed to send test alert: ${err.message}` });
        }
    });
}

module.exports = webhookRoutes;
