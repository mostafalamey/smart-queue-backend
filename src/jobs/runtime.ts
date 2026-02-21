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
  enqueueJob: (
    name: AsyncJobName,
    payload: AsyncJobPayload,
    delayMs?: number
  ) => Promise<string | undefined>;
  stop: () => Promise<void>;
}

const createJobProcessor = () => {
  return async (job: Job<AsyncJobData>): Promise<void> => {
    const payload = job.data.payload;
    const payloadKeys = Object.keys(payload);

    console.log("[jobs] Processing async job skeleton", {
      id: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      requestId: payload.requestId,
      payloadKeyCount: payloadKeys.length,
      payloadKeys,
    });
  };
};

const parseRedisUrl = (
  redisUrl: string,
  options?: { worker?: boolean }
): RedisConnectionConfig => {
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("Invalid REDIS_URL: expected a valid redis:// or rediss:// URL");
  }

  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("Invalid REDIS_URL: protocol must be redis:// or rediss://");
  }

  const dbPath = parsed.pathname.replace(/^\//, "").trim();

  if (dbPath.length > 0 && !/^\d+$/.test(dbPath)) {
    throw new Error("Invalid Redis DB index in REDIS_URL");
  }

  if (parsed.port.length > 0 && !/^\d+$/.test(parsed.port)) {
    throw new Error("Invalid Redis port in REDIS_URL");
  }

  const parsedDbIndex = dbPath.length > 0 ? Number.parseInt(dbPath, 10) : 0;
  const parsedPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 6379;

  if (Number.isNaN(parsedPort)) {
    throw new Error("Invalid Redis port in REDIS_URL");
  }

  const config: RedisConnectionConfig = {
    host: parsed.hostname,
    port: parsedPort,
    username: parsed.username.length > 0 ? parsed.username : undefined,
    password: parsed.password.length > 0 ? parsed.password : undefined,
    db: parsedDbIndex,
  };

  if (parsed.protocol === "rediss:") {
    config.tls = {};
  }

  if (options?.worker) {
    config.maxRetriesPerRequest = null;
  }

  return config;
};

export const createAsyncJobsRuntime = (
  redisUrl: string,
  workerConcurrency = 1,
  retainCompletedJobs = 1_000,
  retainFailedJobs = 1_000
): AsyncJobsRuntime => {
  let isStarted = false;

  const normalizedWorkerConcurrency =
    Number.isFinite(workerConcurrency) && workerConcurrency > 0
      ? Math.floor(workerConcurrency)
      : 1;
  const normalizedRetainCompletedJobs =
    Number.isFinite(retainCompletedJobs) && retainCompletedJobs > 0
      ? Math.floor(retainCompletedJobs)
      : 1_000;
  const normalizedRetainFailedJobs =
    Number.isFinite(retainFailedJobs) && retainFailedJobs > 0
      ? Math.floor(retainFailedJobs)
      : 1_000;

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
        removeOnComplete: normalizedRetainCompletedJobs,
        removeOnFail: normalizedRetainFailedJobs,
      },
    }
  );

  const queueEvents = new QueueEvents(ASYNC_JOB_QUEUE_NAME, {
    connection: queueEventsConnection,
  });

  queue.on("error", (error) => {
    console.error("[jobs] Queue connection error", {
      queueName: ASYNC_JOB_QUEUE_NAME,
      error: error.message,
    });
  });

  queueEvents.on("error", (error) => {
    console.error("[jobs] QueueEvents connection error", {
      queueName: ASYNC_JOB_QUEUE_NAME,
      error: error.message,
    });
  });

  const worker = new Worker<AsyncJobData, void, AsyncJobName>(
    ASYNC_JOB_QUEUE_NAME,
    createJobProcessor(),
    {
      connection: workerConnection,
      concurrency: normalizedWorkerConcurrency,
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

  worker.on("error", (error) => {
    console.error("[jobs] Worker connection error", {
      queueName: ASYNC_JOB_QUEUE_NAME,
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

      isStarted = true;

      console.log("[jobs] Async jobs baseline ready", {
        queueName: ASYNC_JOB_QUEUE_NAME,
        workerConcurrency: normalizedWorkerConcurrency,
        retainCompletedJobs: normalizedRetainCompletedJobs,
        retainFailedJobs: normalizedRetainFailedJobs,
      });
    },

    enqueueJob: async (
      name: AsyncJobName,
      payload: AsyncJobPayload,
      delayMs = 0
    ) => {
      if (!isStarted) {
        throw new Error(
          "Async jobs runtime is not started. Call start() successfully before enqueueing jobs."
        );
      }

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
      isStarted = false;

      await Promise.all([
        worker.close(),
        queueEvents.close(),
        queue.close(),
      ]);
    },
  };
};
