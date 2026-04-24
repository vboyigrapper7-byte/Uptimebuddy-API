/**
 * Status Page Caching Layer
 * Simple TTL-based in-memory cache to protect the DB from anonymous traffic bursts.
 */
class StatusPageCache {
    constructor(ttlSeconds = 60) {
        this.cache = new Map();
        this.ttl = ttlSeconds * 1000;
    }

    get(slug) {
        const item = this.cache.get(slug);
        if (!item) return null;

        if (Date.now() > item.expiry) {
            this.cache.delete(slug);
            return null;
        }

        return item.data;
    }

    set(slug, data) {
        this.cache.set(slug, {
            data,
            expiry: Date.now() + this.ttl
        });
    }

    invalidate(slug) {
        this.cache.delete(slug);
    }
}

module.exports = new StatusPageCache();
