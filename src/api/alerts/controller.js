const pool = require('../../core/db/pool');
const { z } = require('zod');

const UpdateSettingsSchema = z.object({
    on_down:           z.boolean().nullable().optional(),
    on_up:             z.boolean().nullable().optional(),
    on_warning:        z.boolean().nullable().optional(),
    threshold_retries: z.number().int().min(0).max(10).nullable().optional(),
    cooldown_mins:     z.number().int().min(1).max(1440).nullable().optional(),
    reminder_mins:     z.number().int().min(0).max(1440).nullable().optional(),
    emails_enabled:    z.boolean().nullable().optional(),
    webhooks_enabled:  z.boolean().nullable().optional()
});

const getAlertSettings = async (request, reply) => {
    const userId = request.user.id;
    try {
        const result = await pool.query(
            'SELECT * FROM alert_settings WHERE user_id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            // Return defaults if no settings found
            return reply.send({
                on_down: true,
                on_up: true,
                on_warning: false,
                threshold_retries: 3,
                cooldown_mins: 5,
                reminder_mins: 30,
                emails_enabled: true,
                webhooks_enabled: true
            });
        }
        
        return reply.send(result.rows[0]);
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to fetch alert settings' });
    }
};

const updateAlertSettings = async (request, reply) => {
    const userId = request.user.id;
    const parsed = UpdateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const { on_down, on_up, on_warning, threshold_retries, cooldown_mins, reminder_mins, emails_enabled, webhooks_enabled } = parsed.data;

    try {
        const result = await pool.query(
            `INSERT INTO alert_settings 
                (user_id, on_down, on_up, on_warning, threshold_retries, cooldown_mins, reminder_mins, emails_enabled, webhooks_enabled)
             VALUES (
                $1, 
                COALESCE($2, TRUE), 
                COALESCE($3, TRUE), 
                COALESCE($4, FALSE), 
                COALESCE($5, 3), 
                COALESCE($6, 5), 
                COALESCE($7, 30), 
                COALESCE($8, TRUE), 
                COALESCE($9, TRUE)
             )
             ON CONFLICT (user_id) DO UPDATE SET
                on_down = COALESCE($2, alert_settings.on_down),
                on_up = COALESCE($3, alert_settings.on_up),
                on_warning = COALESCE($4, alert_settings.on_warning),
                threshold_retries = COALESCE($5, alert_settings.threshold_retries),
                cooldown_mins = COALESCE($6, alert_settings.cooldown_mins),
                reminder_mins = COALESCE($7, alert_settings.reminder_mins),
                emails_enabled = COALESCE($8, alert_settings.emails_enabled),
                webhooks_enabled = COALESCE($9, alert_settings.webhooks_enabled),
                updated_at = NOW()
             RETURNING *`,
            [userId, on_down, on_up, on_warning, threshold_retries, cooldown_mins, reminder_mins, emails_enabled, webhooks_enabled]
        );
        
        return reply.send(result.rows[0]);
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to update alert settings' });
    }
};

const getAlertLogs = async (request, reply) => {
    const userId = request.user.id;
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);

    try {
        const result = await pool.query(
            `SELECT l.*, COALESCE(m.name, 'System/Server') as monitor_name
             FROM alert_history l
             LEFT JOIN monitors m ON l.monitor_id = m.id
             WHERE l.user_id = $1
             ORDER BY l.delivered_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        return reply.send(result.rows);
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to fetch alert history' });
    }
};

const testEmailAlert = async (request, reply) => {
    const userId = request.user.id;
    const userEmail = request.user.email;
    const alertService = require('../../core/alerting/alertService');

    try {
        if (!process.env.RESEND_API_KEY) {
            return reply.code(500).send({ error: 'RESEND_API_KEY is not configured on the server.' });
        }

        const success = await alertService.sendEmail({
            target: 'MonitorHub Test',
            newStatus: 'up',
            errorMessage: 'This is a test notification to verify your email settings.',
            timestamp: new Date().toISOString()
        }, userEmail);

        if (!success) {
            return reply.code(500).send({ error: 'Email service accepted the request but failed to deliver. Check your Resend dashboard.' });
        }

        return reply.send({ message: 'Test email dispatched successfully to ' + userEmail });
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to send test email: ' + err.message });
    }
};

const testWebhookAlert = async (request, reply) => {
    const userId = request.user.id;
    const axios = require('axios');
    const alertService = require('../../core/alerting/alertService');

    try {
        const webhooks = await pool.query('SELECT provider, url FROM webhooks WHERE user_id = $1', [userId]);
        if (webhooks.rows.length === 0) {
            return reply.code(400).send({ error: 'No webhooks configured. Please add one first.' });
        }

        const payload = alertService.getSlackPayload({
            target: 'MonitorHub Test',
            previousStatus: 'pending',
            newStatus: 'up',
            errorMessage: 'Test webhook message',
            timestamp: new Date().toISOString()
        });

        const results = [];
        for (const wh of webhooks.rows) {
            try {
                await axios.post(wh.url, payload, { timeout: 5000 });
                results.push({ provider: wh.provider, status: 'success' });
            } catch (err) {
                results.push({ provider: wh.provider, status: 'failed', error: err.message });
            }
        }

        return reply.send({ message: 'Test webhooks processed', results });
    } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to process test webhooks' });
    }
};

module.exports = { getAlertSettings, updateAlertSettings, getAlertLogs, testEmailAlert, testWebhookAlert };
