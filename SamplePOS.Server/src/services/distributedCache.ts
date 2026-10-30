import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { createThrottle, errorKey } from '../utils/throttledLog.js';

/**
 * DISTRIBUTED CACHE SERVICE
 * Replaces in-memory NodeCache for cluster-safe caching
 * Supports tag-based invalidation for complex dependencies
 */

export class DistributedCacheService {
    private redis: Redis;
    private readonly DEFAULT_TTL = 3600; // 1 hour
    private readonly TAG_PREFIX = 'tag:';
    private readonly KEY_PREFIX = 'cache:';

    constructor() {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 1, // Fail fast: 2s max instead of 6s
            enableOfflineQueue: false, // Don't queue commands when disconnected
        });

        // Throttled: ioredis emits 'error' on every reconnect attempt while Redis is down.
        const throttle = createThrottle(30_000);
        this.redis.on('error', (err: Error) => {
            throttle(errorKey('cache', err), (suppressed) =>
                logger.error('Redis connection error:', err, suppressed > 0 ? { suppressed } : undefined),
            );
        });

        this.redis.on('connect', () => {
            logger.info('Redis connected successfully');
        });
    }

    /**
     * Get cached value
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const value = await this.redis.get(this.KEY_PREFIX + key);
            if (!value) return null;

            return JSON.parse(value) as T;
        } catch (error) {
            logger.error(`Cache get error for key ${key}:`, error);
            return null;
        }
    }

    /**
     * Set cached value with optional TTL and tags
     */
    async set(
        key: string,
        value: unknown,
        options: {
            ttl?: number;
            tags?: string[];
        } = {}
    ): Promise<void> {
        try {
            const { ttl = this.DEFAULT_TTL, tags = [] } = options;
            const fullKey = this.KEY_PREFIX + key;

            // Store the value
            await this.redis.setex(fullKey, ttl, JSON.stringify(value));

            // Associate with tags for invalidation
            if (tags.length > 0) {
                await this.associateTags(fullKey, tags);
            }

            logger.debug(`Cache set: ${key} (TTL: ${ttl}s, Tags: ${tags.join(', ')})`);
        } catch (error) {
            logger.error(`Cache set error for key ${key}:`, error);
        }
    }

    /**
     * Delete specific key
     */
    async delete(key: string): Promise<void> {
        try {
            await this.redis.del(this.KEY_PREFIX + key);
            logger.debug(`Cache deleted: ${key}`);
        } catch (error) {
            logger.error(`Cache delete error for key ${key}:`, error);
        }
    }

    /**
     * Invalidate all keys associated with a tag
     */
    async invalidateByTag(tag: string): Promise<void> {
        try {
            const tagKey = this.TAG_PREFIX + tag;
            const keys = await this.redis.smembers(tagKey);

            if (keys.length > 0) {
                // Delete all keys in batch
                await this.redis.del(...keys);
                logger.info(`Invalidated ${keys.length} cache entries for tag: ${tag}`);
            }

            // Clean up the tag set
            await this.redis.del(tagKey);
        } catch (error) {
            logger.error(`Cache invalidation error for tag ${tag}:`, error);
        }
    }

    /**
     * Invalidate multiple tags at once
     */
    async invalidateByTags(tags: string[]): Promise<void> {
        await Promise.all(tags.map((tag) => this.invalidateByTag(tag)));
    }

    /**
     * Associate key with tags for group invalidation
     */
    private async associateTags(key: string, tags: string[]): Promise<void> {
        const pipeline = this.redis.pipeline();

        for (const tag of tags) {
            const tagKey = this.TAG_PREFIX + tag;
            pipeline.sadd(tagKey, key);
            // Set expiry on tag set (slightly longer than cached data)
            pipeline.expire(tagKey, this.DEFAULT_TTL + 300);
        }

        await pipeline.exec();
    }

    /**
     * Get or set pattern (cache-aside)
     */
    async getOrSet<T>(
        key: string,
        fetcher: () => Promise<T>,
        options: {
            ttl?: number;
            tags?: string[];
        } = {}
    ): Promise<T> {
        // Try to get from cache
        const cached = await this.get<T>(key);
        if (cached !== null) {
            logger.debug(`Cache hit: ${key}`);
            return cached;
        }

        // Cache miss - fetch data
        logger.debug(`Cache miss: ${key}`);
        const value = await fetcher();

        // Store in cache (don't await to avoid blocking)
        this.set(key, value, options).catch((err) => {
            logger.error(`Background cache set failed for ${key}:`, err);
        });

        return value;
    }

    /**
     * Clear all cache entries (use sparingly!)
     */
    async flush(): Promise<void> {
        try {
            const keys = await this.redis.keys(`${this.KEY_PREFIX}*`);
            if (keys.length > 0) {
                await this.redis.del(...keys);
            }

            const tagKeys = await this.redis.keys(`${this.TAG_PREFIX}*`);
            if (tagKeys.length > 0) {
                await this.redis.del(...tagKeys);
            }

            logger.info('Cache flushed successfully');
        } catch (error) {
            logger.error('Cache flush error:', error);
        }
    }

    /**
     * Check Redis connection health
     */
    async healthCheck(): Promise<boolean> {
        try {
            await this.redis.ping();
            return true;
        } catch (error) {
            logger.error('Redis health check failed:', error);
            return false;
        }
    }

    /**
     * Close Redis connection
     */
    async close(): Promise<void> {
        await this.redis.quit();
    }
}

// Singleton instance
export const distributedCache = new DistributedCacheService();

/**
 * Cache key builders for consistency
 */
export const CacheKeys = {
    // Products
    product: (id: string) => `product:${id}`,
    productList: (page: number, limit: number) => `products:list:${page}:${limit}`,
    productBysku: (sku: string) => `product:sku:${sku}`,

    // Inventory
    stockLevel: (productId: string) => `stock:level:${productId}`,
    stockLevels: (page: number) => `stock:levels:${page}`,
    batchesByProduct: (productId: string) => `batches:product:${productId}`,

    // Pricing
    productPrice: (productId: string, customerGroupId?: string) =>
        `price:${productId}:${customerGroupId || 'default'}`,
    pricingTiers: (productId: string) => `pricing:tiers:${productId}`,

    // MUoM
    productUoms: (productId: string) => `uoms:product:${productId}`,
    uomConversion: (productId: string, fromUom: string, toUom: string) =>
        `uom:convert:${productId}:${fromUom}:${toUom}`,

    // Customers
    customer: (id: string) => `customer:${id}`,
    customerByPhone: (phone: string) => `customer:phone:${phone}`,
};

/**
 * Cache tags for invalidation
 */
export const CacheTags = {
    PRODUCTS: 'products',
    PRODUCT: (id: string) => `product:${id}`,
    INVENTORY: 'inventory',
    PRICING: 'pricing',
    MUOM: 'muom',
    CUSTOMERS: 'customers',
    SALES: 'sales',
};
