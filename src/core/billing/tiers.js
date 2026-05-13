/**
 * SaaS Tier Definitions for Monitor Hub
 * All limits and features associated with each plan.
 * Pricing is in USD — Razorpay accepts both USD and INR based on the payer's location.
 */

const PLAN_TIERS = {
    free: {
        id: 'free',
        name: 'Free',
        priceUSD: 0,
        limits: {
            uptime: 5,
            api: 2,
            server: 1
        },
        minInterval: 300, // 5 Minutes
        retentionDays: 1, // 24 Hours
        features: {
            advancedApi: false,
            prioritySupport: false
        }
    },
    starter: {
        id: 'starter',
        name: 'Starter',
        priceUSD: 10, // $10/month
        razorpayPlanId: process.env.RAZORPAY_PLAN_STARTER, // plan_xxx
        limits: {
            uptime: 25,
            api: 10,
            server: 3
        },
        minInterval: 60, // 1 Minute
        retentionDays: 7,
        features: {
            advancedApi: true,
            prioritySupport: false
        }
    },
    pro: {
        id: 'pro',
        name: 'Pro',
        priceUSD: 24, // $24/month
        razorpayPlanId: process.env.RAZORPAY_PLAN_PRO, // plan_xxx
        limits: {
            uptime: 100,
            api: 50,
            server: 10
        },
        minInterval: 30, // 30 Seconds
        retentionDays: 30,
        features: {
            advancedApi: true,
            prioritySupport: true
        }
    },
    business: {
        id: 'business',
        name: 'Business',
        priceUSD: 84, // $84/month
        razorpayPlanId: process.env.RAZORPAY_PLAN_BUSINESS, // plan_xxx
        limits: {
            uptime: 500,
            api: 250,
            server: 50
        },
        minInterval: 30, // 30 Seconds
        retentionDays: 365, // 1 Year
        features: {
            advancedApi: true,
            prioritySupport: true,
            dedicatedAccountManager: true
        }
    }
};

// Map pro_trial back to pro limits for transparency
PLAN_TIERS.pro_trial = {
    ...PLAN_TIERS.pro,
    id: 'pro_trial',
    name: 'Pro Trial'
};

module.exports = { PLAN_TIERS };
