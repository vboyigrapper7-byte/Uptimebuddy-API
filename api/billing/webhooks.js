const crypto = require('crypto');

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
    const db = request.server.db;
    const payload = request.body.payload;

    request.log.info(`[BillingWebhook] Received event: ${event}`);

    try {
        // ── 1. Handle Legacy Payment Captured (Single Payments) ────────────────
        if (event === 'payment.captured') {
            const { order_id, id: payment_id } = payload.payment.entity;
            const txRes = await db.query('SELECT user_id, plan_id, status FROM transactions WHERE order_id = $1', [order_id]);
            if (txRes.rows.length > 0 && txRes.rows[0].status !== 'paid') {
                const { user_id, plan_id } = txRes.rows[0];
                await db.query('UPDATE users SET tier = $1, plan_expiry = NOW() + INTERVAL \'32 days\' WHERE id = $2', [plan_id, user_id]);
                await db.query('UPDATE transactions SET payment_id = $1, status = \'paid\' WHERE order_id = $2', [payment_id, order_id]);
                request.log.info(`[BillingWebhook] Upgraded user ${user_id} via payment.captured`);
            }
        }

        // ── 2. Handle Subscription Renewals ────────────────────────────────────
        else if (event === 'subscription.charged') {
            const { id: sub_id, customer_id, notes } = payload.subscription.entity;
            const user_id = notes?.user_id;

            if (user_id) {
                // Determine plan from subscription data if possible, or keep existing
                await db.query(
                    'UPDATE users SET plan_expiry = NOW() + INTERVAL \'32 days\', subscription_id = $1 WHERE id = $2',
                    [sub_id, user_id]
                );
                request.log.info(`[BillingWebhook] Extended subscription for user ${user_id} (Sub: ${sub_id})`);
            }
        }

        // ── 3. Handle Subscription Cancellations/Failures ──────────────────────
        else if (event === 'subscription.cancelled' || event === 'subscription.halted') {
            const { id: sub_id, notes } = payload.subscription.entity;
            const user_id = notes?.user_id;

            if (user_id) {
                // Immediate downgrade or mark for expiry (depending on business logic)
                // For now, we clear the expiry to force a downgrade on next check
                await db.query(
                    'UPDATE users SET tier = \'free\', plan_expiry = NOW(), subscription_id = NULL WHERE id = $1',
                    [user_id]
                );
                request.log.info(`[BillingWebhook] Downgraded user ${user_id} due to ${event}`);
            }
        }
    } catch (err) {
        request.log.error(`[BillingWebhook] Critical error processing ${event}: ${err.message}`);
        return reply.code(500).send({ message: 'Internal processing error' });
    }

    return reply.send({ status: 'ok' });
};

module.exports = { handleWebhook };
