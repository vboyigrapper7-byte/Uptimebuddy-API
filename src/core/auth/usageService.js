/**
 * Monitor Hub Usage & Limit Enforcement Service
 * Centralized logic for tracking SaaS quotas and feature gating.
 */

const { PLAN_TIERS } = require('../billing/tiers');

/**
 * Get full usage statistics for a user
 * @param {object} db Fastify database decorator (pg pool)
 * @param {number} userId 
 */
async function getUserUsage(db, userId) {
    // 1. Fetch monitor counts by category
    const monitorRes = await db.query(
        `SELECT category, COUNT(*) as count 
         FROM monitors 
         WHERE user_id = $1 
         GROUP BY category`,
        [userId]
    );

    const counts = {
        uptime: 0,
        api: 0,
        server: 0
    };

    monitorRes.rows.forEach(row => {
        if (counts.hasOwnProperty(row.category)) {
            counts[row.category] = parseInt(row.count, 10);
        }
    });

    // 2. Fetch server agent counts
    const agentRes = await db.query(
        'SELECT COUNT(*) as count FROM agents WHERE user_id = $1',
        [userId]
    );
    counts.server = parseInt(agentRes.rows[0].count, 10);

    // 3. Fetch count of records in Recycle Bin (scheduled for deletion)
    const recycleRes = await db.query(
        `SELECT COUNT(*) as count 
         FROM monitor_metrics mm
         JOIN monitors m ON mm.monitor_id = m.id
         WHERE m.user_id = $1 AND mm.deletion_scheduled_at IS NOT NULL`,
        [userId]
    );
    counts.recycleBin = parseInt(recycleRes.rows[0].count, 10);

    return counts;
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
    const tierConfig = PLAN_TIERS[user.tier] || PLAN_TIERS.free;
    
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
 * Get effective limits for a user
 * @param {string} tier 
 */
function getTierLimits(tier) {
    return PLAN_TIERS[tier] || PLAN_TIERS.free;
}

/**
 * Get IDs of monitors that exceed current tier limits (sorted by newest first)
 * @param {object} db 
 * @param {object} user 
 */
async function getOverLimitMonitors(db, user) {
    const usage = await getUserUsage(db, user.id);
    const tierConfig = PLAN_TIERS[user.tier] || PLAN_TIERS.free;
    
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
    getTierLimits,
    getOverLimitMonitors
};
