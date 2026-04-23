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

    if (event === 'payment.captured') {
        const { order_id, id: payment_id, notes } = request.body.payload.payment.entity;
        
        // Fetch transaction
        const txRes = await db.query('SELECT user_id, plan_id, status FROM transactions WHERE order_id = $1', [order_id]);
        if (txRes.rows.length > 0 && txRes.rows[0].status !== 'paid') {
            const { user_id, plan_id } = txRes.rows[0];

            // Perform upgrade
            await db.query('UPDATE users SET tier = $1, updated_at = NOW() WHERE id = $2', [plan_id, user_id]);
            await db.query('UPDATE transactions SET payment_id = $1, status = $2, updated_at = NOW() WHERE order_id = $3', 
                [payment_id, 'paid', order_id]);
            
            request.log.info(`Webhook: Successfully upgraded user ${user_id} to ${plan_id} via webhook`);
        }
    }

    return reply.send({ status: 'ok' });
};

module.exports = { handleWebhook };
