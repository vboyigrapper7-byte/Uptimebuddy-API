const crypto = require('crypto');
const pool = require('../../core/db/pool');

const handleWebhook = async (request, reply) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = request.headers['x-razorpay-signature'];

    // Verify webhook signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(request.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
        request.log.warn('Invalid Razorpay webhook signature');
        return reply.code(400).send({ message: 'Invalid signature' });
    }

    const event = request.body.event;
    // Razorpay webhook ID is often in the account_id or specific to the event
    const eventId = request.body.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`; 
    const payload = request.body.payload;

    request.log.info(`[BillingWebhook] Received event: ${event} (EventID: ${eventId})`);

    try {
        // ── IDEMPOTENCY CHECK ────────────────────────────────────────────────
        const checkRes = await pool.query('SELECT 1 FROM processed_webhooks WHERE event_id = $1', [eventId]);
        if (checkRes.rows.length > 0) {
            request.log.info(`[BillingWebhook] Event ${eventId} already processed. Skipping.`);
            return reply.send({ status: 'ok', duplicated: true });
        }

        // ── 1. Handle Legacy Payment Captured (One-time Orders) ───────────────
        if (event === 'payment.captured') {
            const { order_id, id: payment_id } = payload.payment.entity;
            const txRes = await pool.query('SELECT user_id, plan_id, status FROM transactions WHERE order_id = $1', [order_id]);
            if (txRes.rows.length > 0 && txRes.rows[0].status !== 'paid') {
                const { user_id, plan_id } = txRes.rows[0];
                await pool.query('UPDATE users SET tier = $1, plan_expiry = NOW() + INTERVAL \'32 days\', updated_at = NOW() WHERE id = $2', [plan_id, user_id]);
                await pool.query('UPDATE transactions SET payment_id = $1, status = \'paid\', updated_at = NOW() WHERE order_id = $2', [payment_id, order_id]);
                request.log.info(`[BillingWebhook] Upgraded user ${user_id} via payment.captured`);
            }
        }

        // ── 2. Handle Subscription Activation & Renewals ───────────────────────
        else if (event === 'subscription.activated' || event === 'subscription.charged') {
            const subEntity = payload.subscription.entity;
            const sub_id = subEntity.id;
            const notes = subEntity.notes;
            const current_end = subEntity.current_end;
            
            const user_id = notes?.user_id;
            const plan_id = notes?.plan_id;

            if (user_id) {
                const expiryDate = current_end ? new Date(current_end * 1000) : new Date(Date.now() + 32 * 24 * 60 * 60 * 1000);
                
                await pool.query(`
                    UPDATE users 
                    SET tier = $1, plan_expiry = $2, subscription_id = $3, subscription_status = 'active', updated_at = NOW() 
                    WHERE id = $4
                `, [plan_id || 'pro', expiryDate, sub_id, user_id]);
                
                request.log.info(`[BillingWebhook] Subscription ${event} for user ${user_id} (Sub: ${sub_id})`);
            }
        }

        // ── 3. Handle Subscription Cancellations/Failures ──────────────────────
        else if (['subscription.cancelled', 'subscription.halted', 'subscription.expired'].includes(event)) {
            const subEntity = payload.subscription.entity;
            const sub_id = subEntity.id;
            const notes = subEntity.notes;
            const user_id = notes?.user_id;

            if (user_id) {
                await pool.query(
                    'UPDATE users SET tier = \'free\', subscription_status = $1, updated_at = NOW() WHERE id = $2',
                    [event.split('.')[1], user_id]
                );
                request.log.info(`[BillingWebhook] Downgraded user ${user_id} due to ${event}`);
            }
        }

        // MARK AS PROCESSED
        await pool.query('INSERT INTO processed_webhooks (event_id) VALUES ($1)', [eventId]);

    } catch (err) {
        request.log.error(`[BillingWebhook] Critical error processing ${event}: ${err.message}`);
        // We return 200 even on error to prevent Razorpay from retrying infinitely while we fix the code
        return reply.send({ status: 'error', message: err.message });
    }

    return reply.send({ status: 'ok' });
};

module.exports = { handleWebhook };
