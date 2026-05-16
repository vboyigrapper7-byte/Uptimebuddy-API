/**
 * Monitor Hub Usage & Limit Enforcement Service
 * Centralized logic for tracking SaaS quotas and feature gating.
 */

const { PLAN_TIERS } = require('../billing/tiers');
const planService = require('../billing/planService');

/**
 * Get full usage statistics for a user
 * @param {object} db Fastify database decorator (pg pool)
 * @param {number} userId 
 */
async function getUserUsage(db, userId) {
    /**
     * Optimized single-query usage fetch.
     * Counts monitors by category and agents in one database round-trip.
     */
    const res = await db.query(
        `SELECT 
            COUNT(*) FILTER (WHERE category = 'uptime' OR category IS NULL) as uptime,
            COUNT(*) FILTER (WHERE category = 'api') as api,
            (SELECT COUNT(*) FROM agents WHERE user_id = $1) as server
         FROM monitors 
         WHERE user_id = $1`,
        [userId]
    );

    const row = res.rows[0];

    // Fetch reports count (last 30 days)
    const reportRes = await db.query(
        "SELECT COUNT(*) as count FROM reports WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'",
        [userId]
    );

    return {
        uptime: parseInt(row.uptime || 0, 10),
        api: parseInt(row.api || 0, 10),
        server: parseInt(row.server || 0, 10),
        reports: parseInt(reportRes.rows[0].count || 0, 10),
        recycleBin: 0
    };
}

/**
 * Check if a user is allowed to perform an action based on their tier limits
 * @param {object} db 
 * @param {object} user User object containing id and tier
 * @param {string} category 'uptime' | 'api' | 'server'
 * @throws {Error} if limit is exceeded
 */
async function checkLimit(db, user, category) {
    const usage = await getUserUsage(db, user.id);
    const tierConfig = planService.getEffectiveTier(user);
    
    // Safety check for valid category
    if (!tierConfig.limits.hasOwnProperty(category)) {
        throw new Error(`Invalid monitor category: ${category}`);
    }

    const currentCount = usage[category];
    const maxAllowed = tierConfig.limits[category];

    if (currentCount >= maxAllowed) {
        const error = new Error(`Limit reached: Your ${user.tier} plan only allows ${maxAllowed} ${category} monitors.`);
        error.statusCode = 403;
        error.limitReached = true;
        error.upgradeRequired = true;
        throw error;
    }

    return { currentCount, maxAllowed };
}

/**
 * Validate and sanitize check interval based on user tier
 * @param {object} user 
 * @param {number} requestedInterval 
 * @returns {number} The effective interval (clamped to minInterval)
 */
function getEffectiveInterval(user, requestedInterval) {
    const tierConfig = planService.getEffectiveTier(user);
    const minAllowed = tierConfig.minInterval || 300;
    return Math.max(requestedInterval, minAllowed);
}

/**
 * Get effective limits for a user
 * @param {string} tier 
 */
function getTierLimits(user) {
    return planService.getEffectiveTier(user);
}

/**
 * Get IDs of monitors that exceed current tier limits (sorted by newest first)
 * @param {object} db 
 * @param {object} user 
 */
async function getOverLimitMonitors(db, user) {
    const usage = await getUserUsage(db, user.id);
    const tierConfig = planService.getEffectiveTier(user);
    
    let overLimitIds = [];

    for (const category of ['uptime', 'api']) {
        const limit = tierConfig.limits[category];
        const currentCount = usage[category];

        if (currentCount > limit) {
            const overCount = currentCount - limit;
            const res = await db.query(
                `SELECT id FROM monitors 
                 WHERE user_id = $1 AND category = $2 AND status != 'paused'
                 ORDER BY created_at DESC 
                 LIMIT $3`,
                [user.id, category, overCount]
            );
            overLimitIds = overLimitIds.concat(res.rows.map(r => r.id));
        }
    }

    return overLimitIds;
}

module.exports = {
    getUserUsage,
    checkLimit,
    getEffectiveInterval,
    getTierLimits,
    getOverLimitMonitors
};
