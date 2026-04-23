const Razorpay = require('razorpay');
const crypto = require('crypto');
const { PLAN_TIERS } = require('../../core/billing/tiers');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Fixed INR Pricing (based on round-off as requested)
const INR_PRICES = {
    free: 0,
    starter: 799,
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

        return reply.send({
            id: order.id,
            currency: order.currency,
            amount: order.amount
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

        // Signature is valid. Update user's tier in DB.
        const db = request.server.db;
        
        // We assume users table has a 'tier' column. (It does, we've seen it).
        // Update user tier
        await db.query(`
            UPDATE users 
            SET tier = $1, updated_at = NOW()
            WHERE id = $2
        `, [planId, request.user.id]);

        return reply.send({
            success: true,
            message: 'Payment verified and plan upgraded successfully!',
            tier: planId
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
