const Razorpay = require('razorpay');
const crypto = require('crypto');
const { PLAN_TIERS } = require('../../core/billing/tiers');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Fixed USD Pricing (rounded, accepts payment in INR or USD based on payer location)
const USD_PRICES = {
    free: 0,
    starter: 10,
    pro: 24,
    business: 84
};

const createOrder = async (request, reply) => {
    try {
        const { planId } = request.body;
        
        if (!planId || !PLAN_TIERS[planId]) {
            return reply.code(400).send({ message: 'Invalid plan selected' });
        }

        const priceInUSD = USD_PRICES[planId];
        
        if (!priceInUSD || priceInUSD === 0) {
             return reply.code(400).send({ message: 'Free plans do not require a payment order.' });
        }

        const options = {
            amount: priceInUSD * 100, // Amount in cents (USD)
            currency: 'USD',
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

const createSubscription = async (request, reply) => {
    try {
        const { planId } = request.body;
        const plan = PLAN_TIERS[planId];
        
        if (!plan || !plan.razorpayPlanId) {
            request.log.warn(`Subscription attempt failed: Plan metadata or ID missing for ${planId}`);
            return reply.code(400).send({ message: 'Invalid subscription plan selected or plan ID missing.' });
        }

        // CONFIG GUARD: Ensure API keys exist
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            request.log.error('CRITICAL: Razorpay API keys are missing in ENV.');
            return reply.code(500).send({ message: 'Billing system misconfigured (Keys missing).' });
        }

        const options = {
            plan_id: plan.razorpayPlanId,
            customer_notify: 1,
            total_count: 120, // 10 years
            notes: {
                user_id: request.user.id,
                plan_id: planId
            }
        };

        request.log.info(`[Billing] Creating Razorpay subscription for user ${request.user.id} (Plan: ${planId})`);
        const subscription = await razorpay.subscriptions.create(options);

        // PERSISTENCE: Save subscription reference to transactions
        await request.server.db.query(
            'INSERT INTO transactions (user_id, subscription_id, plan_id, amount, status) VALUES ($1, $2, $3, $4, $5)',
            [request.user.id, subscription.id, planId, plan.priceUSD * 100, 'pending']
        );

        return reply.send({
            id: subscription.id,
            key_id: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        request.log.error('Razorpay Create Subscription Error:', {
            message: error.message,
            description: error.description,
            code: error.code,
            userId: request.user.id
        });
        return reply.code(500).send({ 
            message: 'Failed to initialize subscription gateway.',
            error: error.description || error.message 
        });
    }
};

const verifyPayment = async (request, reply) => {
    try {
        const { razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, razorpay_signature, planId } = request.body;
        
        if ((!razorpay_order_id && !razorpay_subscription_id) || !razorpay_payment_id || !razorpay_signature || !planId) {
             return reply.code(400).send({ message: 'Missing payment verification parameters.' });
        }

        // Verify Signature
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const data = razorpay_subscription_id 
            ? `${razorpay_payment_id}|${razorpay_subscription_id}` 
            : `${razorpay_order_id}|${razorpay_payment_id}`;

        const generated_signature = crypto
            .createHmac('sha256', secret)
            .update(data)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            request.log.error('[Billing] Signature Mismatch!', {
                received: razorpay_signature,
                generated: generated_signature,
                data: data,
                type: razorpay_subscription_id ? 'subscription' : 'order'
            });
            return reply.code(400).send({ message: 'Invalid payment signature. Verification failed.' });
        }

        request.log.info(`[Billing] Signature verified successfully for ${razorpay_subscription_id || razorpay_order_id}`);

        const db = request.server.db;

        // ANTI-TAMPERING: Fetch original plan from DB, do not trust request.body.planId
        const txQuery = razorpay_subscription_id 
            ? 'SELECT plan_id, status FROM transactions WHERE subscription_id = $1'
            : 'SELECT plan_id, status FROM transactions WHERE order_id = $1';
        const txId = razorpay_subscription_id || razorpay_order_id;

        const txRes = await db.query(txQuery, [txId]);
        if (txRes.rows.length === 0) {
            request.log.error('[Billing] Transaction NOT found in DB!', { txId, type: razorpay_subscription_id ? 'subscription' : 'order' });
            return reply.code(404).send({ message: 'Transaction reference not found in system.' });
        }
        
        const transaction = txRes.rows[0];
        if (transaction.status === 'paid') {
            return reply.send({ success: true, message: 'Payment already processed.', tier: transaction.plan_id });
        }

        const verifiedPlanId = transaction.plan_id;

        // Update user's tier and subscription info
        if (razorpay_subscription_id) {
            await db.query(`
                UPDATE users 
                SET tier = $1, subscription_id = $2, subscription_status = 'active', updated_at = NOW()
                WHERE id = $3
            `, [verifiedPlanId, razorpay_subscription_id, request.user.id]);
        } else {
            await db.query(`
                UPDATE users 
                SET tier = $1, updated_at = NOW()
                WHERE id = $2
            `, [verifiedPlanId, request.user.id]);
        }

        // Mark transaction as paid (IDEMPOTENCY)
        await db.query(
            `UPDATE transactions SET payment_id = $1, status = $2, updated_at = NOW() 
             WHERE ${razorpay_subscription_id ? 'subscription_id' : 'order_id'} = $3`,
            [razorpay_payment_id, 'paid', txId]
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
        prices: USD_PRICES,
        currency: 'USD'
    });
};

module.exports = {
    createOrder,
    createSubscription,
    verifyPayment,
    getPlans
};
