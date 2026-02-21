import { Job, Queue, QueueEvents, Worker } from "bullmq";

const ASYNC_JOB_QUEUE_NAME = "smart-queue-async-jobs";

const DEFAULT_JOB_ATTEMPTS = 3;
const DEFAULT_JOB_BACKOFF_MS = 1_000;

export type AsyncJobName = "notification.retry" | "retention.purge";

export interface AsyncJobPayload {
  requestId?: string;
  scheduledFor?: string;
  metadata?: Record<string, unknown>;
}

interface AsyncJobData {
  createdAt: string;
  payload: AsyncJobPayload;
}

interface RedisConnectionConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest?: null;
}

export interface AsyncJobsRuntime {
  start: () => Promise<void>;
  enqueueSkeletonJob: (
    name: AsyncJobName,
    payload: AsyncJobPayload,
    delayMs?: number
  ) => Promise<string | undefined>;
  stop: () => Promise<void>;
}

const createJobProcessor = () => {
  return async (job: Job<AsyncJobData>): Promise<void> => {
    console.log("[jobs] Processing async job skeleton", {
      id: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      payload: job.data.payload,
    });
  };
};

const parseRedisUrl = (
  redisUrl: string,
  options?: { worker?: boolean }
): RedisConnectionConfig => {
  const parsed = new URL(redisUrl);
  const dbPath = parsed.pathname.replace(/^\//, "").trim();

  const config: RedisConnectionConfig = {
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 6379,
    username: parsed.username.length > 0 ? parsed.username : undefined,
    password: parsed.password.length > 0 ? parsed.password : undefined,
    db: dbPath.length > 0 ? Number.parseInt(dbPath, 10) : 0,
  };

  if (parsed.protocol === "rediss:") {
    config.tls = {};
  }

  if (options?.worker) {
    config.maxRetriesPerRequest = null;
  }

  return config;
};

export const createAsyncJobsRuntime = (redisUrl: string): AsyncJobsRuntime => {
  const queueConnection = parseRedisUrl(redisUrl);
  const workerConnection = parseRedisUrl(redisUrl, { worker: true });
  const queueEventsConnection = parseRedisUrl(redisUrl);

  const queue = new Queue<AsyncJobData, void, AsyncJobName>(
    ASYNC_JOB_QUEUE_NAME,
    {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: DEFAULT_JOB_BACKOFF_MS,
      },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
    }
  );

  const queueEvents = new QueueEvents(ASYNC_JOB_QUEUE_NAME, {
    connection: queueEventsConnection,
  });

  const worker = new Worker<AsyncJobData, void, AsyncJobName>(
    ASYNC_JOB_QUEUE_NAME,
    createJobProcessor(),
    {
      connection: workerConnection,
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log("[jobs] Job completed", {
      id: job.id,
      name: job.name,
    });
  });

  worker.on("failed", (job, error) => {
    console.error("[jobs] Job failed", {
      id: job?.id,
      name: job?.name,
      error: error.message,
    });
  });

  return {
    start: async () => {
      await Promise.all([
        queue.waitUntilReady(),
        worker.waitUntilReady(),
        queueEvents.waitUntilReady(),
      ]);

      console.log("[jobs] Async jobs baseline ready", {
        queueName: ASYNC_JOB_QUEUE_NAME,
      });
    },

    enqueueSkeletonJob: async (
      name: AsyncJobName,
      payload: AsyncJobPayload,
      delayMs = 0
    ) => {
      const normalizedDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      const job = await queue.add(
        name,
        {
          createdAt: new Date().toISOString(),
          payload,
        },
        {
          delay: normalizedDelay,
        }
      );

      return job.id?.toString();
    },

    stop: async () => {
      await Promise.all([
        worker.close(),
        queueEvents.close(),
        queue.close(),
      ]);
    },
  };
};
