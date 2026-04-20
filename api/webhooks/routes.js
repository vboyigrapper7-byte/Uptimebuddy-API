const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;
const ALLOWED_PROVIDERS = ['slack', 'discord', 'telegram'];

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

        // URL validation + SSRF guard (Exempt Telegram as it uses token|id format)
        if (provider !== 'telegram') {
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
        } else {
            // For telegram, just ensure it contains the pipe separator
            if (!url.includes('|')) {
                return reply.status(400).send({ error: 'Telegram format must be bot_token|chat_id' });
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
}

module.exports = webhookRoutes;
