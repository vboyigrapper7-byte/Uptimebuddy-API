const Razorpay = require('razorpay');
const crypto = require('crypto');
const { PLAN_TIERS } = require('../../core/billing/tiers');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const INR_PRICES = {
    free: 0,
    starter: 10,
    pro: 1999,
    business: 6999
};

const createOrder = async (request, reply) => {
    try {
        const { planId } = request.body;
        
        if (!planId || !PLAN_TIERS[planId]) {
            return reply.code(400).send({ message: 'Invalid plan selected' });
        }

        const priceInINR = INR_PRICES[planId];
        
        if (!priceInINR || priceInINR === 0) {
             return reply.code(400).send({ message: 'Free plans do not require a payment order.' });
        }

        const options = {
            amount: priceInINR * 100, // Amount in paisa
            currency: 'INR',
            receipt: `receipt_order_${request.user.id}_${Date.now()}`,
            payment_capture: 1 // Auto capture
        };

        const order = await razorpay.orders.create(options);

        // PERSISTENCE: Save order to DB before returning to frontend
        await request.server.db.query(
            'INSERT INTO transactions (user_id, order_id, plan_id, amount, status) VALUES ($1, $2, $3, $4, $5)',
            [request.user.id, order.id, planId, options.amount, 'pending']
        );

        return reply.send({
            id: order.id,
            currency: order.currency,
            amount: order.amount,
            key_id: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        request.log.error('Razorpay Create Order Error:', error);
        return reply.code(500).send({ message: 'Failed to generate payment gateway order.' });
    }
};

const verifyPayment = async (request, reply) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = request.body;
        
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId) {
             return reply.code(400).send({ message: 'Missing payment verification parameters.' });
        }

        // Verify Signature
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const generated_signature = crypto
            .createHmac('sha256', secret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            return reply.code(400).send({ message: 'Invalid payment signature. Verification failed.' });
        }

        const db = request.server.db;

        // ANTI-TAMPERING: Fetch original plan from DB, do not trust request.body.planId
        const txRes = await db.query('SELECT plan_id, status FROM transactions WHERE order_id = $1', [razorpay_order_id]);
        if (txRes.rows.length === 0) {
            return reply.code(404).send({ message: 'Order reference not found in system.' });
        }
        
        const transaction = txRes.rows[0];
        if (transaction.status === 'paid') {
            return reply.send({ success: true, message: 'Payment already processed.', tier: transaction.plan_id });
        }

        const verifiedPlanId = transaction.plan_id;

        // Update user's tier
        await db.query(`
            UPDATE users 
            SET tier = $1, updated_at = NOW()
            WHERE id = $2
        `, [verifiedPlanId, request.user.id]);

        // Mark transaction as paid (IDEMPOTENCY)
        await db.query(
            'UPDATE transactions SET payment_id = $1, status = $2, updated_at = NOW() WHERE order_id = $3',
            [razorpay_payment_id, 'paid', razorpay_order_id]
        );

        return reply.send({
            success: true,
            message: 'Payment verified and plan upgraded successfully!',
            tier: verifiedPlanId
        });
    } catch (error) {
         request.log.error('Razorpay Verify Error:', error);
         return reply.code(500).send({ message: 'Failed to verify payment.' });
    }
};

const getPlans = async (request, reply) => {
    return reply.send({
        tiers: PLAN_TIERS,
        prices: INR_PRICES,
        currency: 'INR'
    });
};

module.exports = {
    createOrder,
    verifyPayment,
    getPlans
};
