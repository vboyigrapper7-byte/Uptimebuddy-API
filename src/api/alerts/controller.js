const pool = require('../../core/db/pool');
const { z } = require('zod');

const UpdateSettingsSchema = z.object({
    on_down:           z.boolean().optional(),
    on_up:             z.boolean().optional(),
    on_warning:        z.boolean().optional(),
    threshold_retries: z.number().int().min(0).max(10).optional(),
    cooldown_mins:     z.number().int().min(1).max(1440).optional(),
    reminder_mins:     z.number().int().min(0).max(1440).optional(),
    emails_enabled:    z.boolean().optional(),
    webhooks_enabled:  z.boolean().optional()
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            `SELECT l.*, m.name as monitor_name
             FROM alert_logs l
             JOIN monitors m ON l.monitor_id = m.id
             WHERE l.user_id = $1
             ORDER BY l.delivered_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        return reply.send(result.rows);
    } catch (err) {
        request.log.error(err);
        reply.code(500).send({ error: 'Failed to fetch alert logs' });
    }
};

module.exports = { getAlertSettings, updateAlertSettings, getAlertLogs };
