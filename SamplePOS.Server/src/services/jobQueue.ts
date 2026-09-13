import Bull, { Queue, Job } from 'bull';
import logger from '../utils/logger.js';

/**
 * JOB QUEUE SERVICE
 * Handles asynchronous heavy operations:
 * - Physical count processing
 * - Report generation
 * - Batch recalculations
 * - Export operations
 */

interface JobData {
    type: string;
    payload: unknown;
    userId: string;
    timestamp: string;
}

class JobQueueService {
    private queues: Map<string, Queue> = new Map();
    private readonly REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
    /** Single dispatcher — Bull drops jobs when multiple process() compete on one queue. */
    private calculationsHandlers = new Map<string, (job: Job<JobData>) => Promise<unknown>>();
    private calculationsProcessorStarted = false;

    constructor() {
        this.initializeQueues();
    }

    private initializeQueues() {
        // Inventory operations queue
        this.createQueue('inventory', {
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
                },
                removeOnComplete: 100, // Keep last 100 completed jobs
                removeOnFail: 500, // Keep last 500 failed jobs
            },
        });

        // Reporting queue (lower priority)
        this.createQueue('reports', {
            defaultJobOptions: {
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                },
                removeOnComplete: 50,
                removeOnFail: 200,
            },
            limiter: {
                max: 5, // Max 5 concurrent report jobs
                duration: 60000, // Per minute
            },
        });

        // Export queue
        this.createQueue('exports', {
            defaultJobOptions: {
                attempts: 2,
                timeout: 300000, // 5 minutes timeout
                removeOnComplete: 50,
                removeOnFail: 100,
            },
        });

        // Calculation queue (high priority, quick jobs)
        this.createQueue('calculations', {
            defaultJobOptions: {
                attempts: 3,
                priority: 1, // Higher priority
                removeOnComplete: 200,
                removeOnFail: 500,
            },
        });

        // CSV import queue (long-running, generous timeout)
        this.createQueue('imports', {
            defaultJobOptions: {
                attempts: 1,           // No auto-retry — import is not idempotent
                timeout: 1800000,      // 30 minutes for very large files
                removeOnComplete: 100,
                removeOnFail: 500,
            },
        });

        // Banking queue — retry failed bank transaction creation
        // Critical for reconciliation: sale committed but bank_transactions missing
        this.createQueue('banking', {
            defaultJobOptions: {
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 5000, // 5s → 10s → 20s → 40s → 80s
                },
                removeOnComplete: 500,
                removeOnFail: 1000,  // Keep failures for audit
            },
        });

        // GL projection events queue — processes gl_projection_events outbox table
        // to keep gl_period_balances in sync without touching the sync request path.
        // Repeating job fires every 30s; individual jobs also fired after each ledger commit.
        this.createQueue('gl_events', {
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 10000, // 10s → 20s → 40s
                },
                removeOnComplete: 200,
                removeOnFail: 500,
            },
        });

        this.createQueue('notifications', {
            defaultJobOptions: {
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                },
                removeOnComplete: 200,
                removeOnFail: 500,
            },
        });
    }

    private createQueue(name: string, options: Bull.QueueOptions = {}) {
        const queue = new Bull(name, this.REDIS_URL, options);

        // Event listeners
        queue.on('error', (error) => {
            logger.error(`Queue ${name} error:`, error);
        });

        queue.on('failed', (job, error) => {
            logger.error(`Job ${job.id} in queue ${name} failed:`, error);
        });

        queue.on('completed', (job) => {
            logger.info(`Job ${job.id} in queue ${name} completed`);
        });

        this.queues.set(name, queue);
        return queue;
    }

    getQueue(name: string): Queue | undefined {
        return this.queues.get(name);
    }

    /**
     * Add job to queue
     */
    async addJob(
        queueName: string,
        jobType: string,
        data: unknown,
        options: Bull.JobOptions = {}
    ): Promise<Job> {
        const queue = this.getQueue(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not found`);
        }

        const jobData: JobData = {
            type: jobType,
            payload: data,
            userId: (data && typeof data === 'object' && 'userId' in data ? String((data as Record<string, unknown>).userId) : null) || 'system',
            timestamp: new Date().toISOString(),
        };

        const job = await queue.add(jobData, options);
        logger.info(`Job ${job.id} added to queue ${queueName}`, { type: jobType });

        return job;
    }

    /**
     * Register a handler for the shared `calculations` queue (one Bull processor dispatches all types).
     */
    registerCalculationsHandler(
        jobType: string,
        handler: (job: Job<JobData>) => Promise<unknown>,
    ): void {
        this.calculationsHandlers.set(jobType, handler);
    }

    /**
     * Start the calculations queue processor after all handlers are registered.
     */
    startCalculationsProcessor(concurrency: number = 1): void {
        if (this.calculationsProcessorStarted) {
            return;
        }
        const queue = this.getQueue('calculations');
        if (!queue) {
            throw new Error('Queue calculations not found');
        }
        this.calculationsProcessorStarted = true;
        queue.process(concurrency, async (job) => {
            logger.info(`Processing job ${job.id} in queue calculations`, { type: job.data.type });
            const handler = this.calculationsHandlers.get(job.data.type);
            if (!handler) {
                const msg = `No calculations handler registered for job type: ${job.data.type}`;
                logger.error(msg);
                throw new Error(msg);
            }
            return handler(job);
        });
    }

    /**
     * Process jobs in queue
     */
    processQueue(
        queueName: string,
        processor: (job: Job<JobData>) => Promise<unknown>,
        concurrency: number = 1
    ) {
        const queue = this.getQueue(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not found`);
        }

        queue.process(concurrency, async (job) => {
            logger.info(`Processing job ${job.id} in queue ${queueName}`, { type: job.data.type });
            return processor(job);
        });
    }

    /**
     * Get job status
     */
    async getJobStatus(queueName: string, jobId: string) {
        const queue = this.getQueue(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not found`);
        }

        const job = await queue.getJob(jobId);
        if (!job) {
            return null;
        }

        const state = await job.getState();
        return {
            id: job.id,
            state,
            progress: job.progress(),
            attemptsMade: job.attemptsMade,
            failedReason: job.failedReason,
            finishedOn: job.finishedOn,
            processedOn: job.processedOn,
            data: job.data,
        };
    }

    /**
     * Get queue stats
     */
    async getQueueStats(queueName: string) {
        const queue = this.getQueue(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not found`);
        }

        const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
        ]);

        return {
            queueName,
            waiting,
            active,
            completed,
            failed,
            delayed,
        };
    }

    /**
     * Clean old jobs
     */
    async cleanQueue(queueName: string, grace: number = 86400000) {
        const queue = this.getQueue(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not found`);
        }

        await queue.clean(grace, 'completed');
        await queue.clean(grace, 'failed');
        logger.info(`Cleaned old jobs from queue ${queueName}`);
    }

    /**
     * Close all queues
     */
    async closeAll() {
        const closePromises = Array.from(this.queues.values()).map((queue) => queue.close());
        await Promise.all(closePromises);
        logger.info('All job queues closed');
    }
}

// Singleton instance
export const jobQueue = new JobQueueService();

/**
 * Job type definitions
 */
export const JobTypes = {
    // Inventory
    PHYSICAL_COUNT_BATCH: 'physical-count-batch',
    BULK_ADJUSTMENT: 'bulk-adjustment',
    STOCK_VALUATION: 'stock-valuation',

    // Reports
    SALES_REPORT: 'sales-report',
    INVENTORY_REPORT: 'inventory-report',
    PROFIT_ANALYSIS: 'profit-analysis',

    // Exports
    EXPORT_SALES: 'export-sales',
    EXPORT_INVENTORY: 'export-inventory',
    EXPORT_MOVEMENTS: 'export-movements',

    // Calculations
    RECALC_PRICING: 'recalc-pricing',
    RECALC_COST_LAYERS: 'recalc-cost-layers',

    // Banking
    CREATE_BANK_TRANSACTION: 'create-bank-transaction',
};
