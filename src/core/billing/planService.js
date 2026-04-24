const { PLAN_TIERS } = require('./tiers');

/**
 * PlanService
 * Centralized logic for feature gating and monitor limits.
 * Designed with a fail-safe: defaults to FREE tier on error.
 */
class PlanService {
    /**
     * Get the active tier for a user, considering expiry.
     */
    getEffectiveTier(user) {
        try {
            if (!user) return PLAN_TIERS.free;

            const tierKey = user.tier || 'free';
            const tier = PLAN_TIERS[tierKey] || PLAN_TIERS.free;

            // Check for expiry
            if (user.plan_expiry) {
                const expiry = new Date(user.plan_expiry);
                if (expiry < new Date()) {
                    return PLAN_TIERS.free;
                }
            }

            return tier;
        } catch (err) {
            console.error('[PlanService] Error calculating effective tier:', err.message);
            return PLAN_TIERS.free;
        }
    }

    /**
     * Check if a specific feature is available for a user.
     */
    canUseFeature(user, featureName) {
        const tier = this.getEffectiveTier(user);
        
        // Basic feature flags from tiers.js
        if (tier.features && tier.features[featureName] === true) {
            return true;
        }

        // Logic-based feature checks
        switch (featureName) {
            case 'advanced_assertions':
                return ['pro', 'business'].includes(tier.id);
            case 'escalation_policies':
                return tier.id === 'business';
            case 'teams':
                return tier.id === 'business';
            case 'audit_logs':
                return tier.id === 'business';
            case 'status_pages':
                return ['pro', 'business'].includes(tier.id);
            default:
                return false;
        }
    }

    /**
     * Get the monitor limit for a specific category.
     */
    getLimit(user, category) {
        const tier = this.getEffectiveTier(user);
        return tier.limits[category] || 0;
    }
}

module.exports = new PlanService();
