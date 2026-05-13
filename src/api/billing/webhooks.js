const crypto = require('crypto');
const auditService = require('../../core/admin/auditService');


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
    const eventId = request.body.id; // Razorpay sends a unique event ID
    const db = request.server.db;
    const payload = request.body.payload;

    request.log.info(`[BillingWebhook] Received event: ${event} (ID: ${eventId})`);

    try {
        // ── IDEMPOTENCY CHECK ────────────────────────────────────────────────
        const checkRes = await db.query('SELECT 1 FROM processed_webhooks WHERE event_id = $1', [eventId]);
        if (checkRes.rows.length > 0) {
            request.log.info(`[BillingWebhook] Event ${eventId} already processed. Skipping.`);
            return reply.send({ status: 'ok', duplicated: true });
        }

        // ── 1. Handle Legacy Payment Captured (One-time Orders) ───────────────
        if (event === 'payment.captured') {
            const { order_id, id: payment_id } = payload.payment.entity;
            const txRes = await db.query('SELECT user_id, plan_id, status FROM transactions WHERE order_id = $1', [order_id]);
            if (txRes.rows.length > 0 && txRes.rows[0].status !== 'paid') {
                const { user_id, plan_id } = txRes.rows[0];
                await db.query('UPDATE users SET tier = $1, plan_expiry = NOW() + INTERVAL \'32 days\' WHERE id = $2', [plan_id, user_id]);
                await db.query('UPDATE transactions SET payment_id = $1, status = \'paid\' WHERE order_id = $2', [payment_id, order_id]);
                
                await auditService.logAction(db, {
                    userId: user_id,
                    action: 'PAYMENT_CAPTURED',
                    entityType: 'transaction',
                    entityId: order_id,
                    newValue: { plan_id, payment_id },
                    ipAddress: request.ip
                });

                request.log.info(`[BillingWebhook] Upgraded user ${user_id} via payment.captured`);
            }
        }

        // ── 2. Handle Subscription Activation & Renewals ───────────────────────
        else if (event === 'subscription.activated' || event === 'subscription.charged') {
            const { id: sub_id, notes, current_end } = payload.subscription.entity;
            const user_id = notes?.user_id;
            const plan_id = notes?.plan_id;

            if (user_id) {
                const expiryDate = current_end ? new Date(current_end * 1000) : new Date(Date.now() + 32 * 24 * 60 * 60 * 1000);
                
                await db.query(`
                    UPDATE users 
                    SET tier = $1, plan_expiry = $2, subscription_id = $3, subscription_status = 'active', updated_at = NOW() 
                    WHERE id = $4
                `, [plan_id || 'pro', expiryDate, sub_id, user_id]);

                await auditService.logAction(db, {
                    userId: user_id,
                    action: event === 'subscription.activated' ? 'SUBSCRIPTION_ACTIVATED' : 'SUBSCRIPTION_RENEWED',
                    entityType: 'subscription',
                    entityId: sub_id,
                    ipAddress: request.ip
                });
                
                request.log.info(`[BillingWebhook] Subscription ${event} for user ${user_id} (Sub: ${sub_id})`);
            }
        }

        // ── 3. Handle Subscription Cancellations/Failures ──────────────────────
        else if (['subscription.cancelled', 'subscription.halted', 'subscription.expired'].includes(event)) {
            const { id: sub_id, notes } = payload.subscription.entity;
            const user_id = notes?.user_id;

            if (user_id) {
                await db.query(
                    'UPDATE users SET tier = \'free\', subscription_status = $1, updated_at = NOW() WHERE id = $2',
                    [event.split('.')[1], user_id]
                );

                await auditService.logAction(db, {
                    userId: user_id,
                    action: 'SUBSCRIPTION_DOWNGRADED',
                    entityType: 'subscription',
                    entityId: sub_id,
                    newValue: { reason: event },
                    ipAddress: request.ip
                });

                request.log.info(`[BillingWebhook] Downgraded user ${user_id} due to ${event}`);
            }
        }

        // MARK AS PROCESSED (FINAL STEP FOR IDEMPOTENCY)
        await db.query('INSERT INTO processed_webhooks (event_id) VALUES ($1)', [eventId]);

    } catch (err) {
        request.log.error(`[BillingWebhook] Critical error processing ${event}: ${err.message}`);
        return reply.code(500).send({ message: 'Internal processing error' });
    }

    return reply.send({ status: 'ok' });
};

module.exports = { handleWebhook };
