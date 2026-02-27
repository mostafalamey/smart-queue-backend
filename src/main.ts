/// <reference path="./types/node-shim.d.ts" />

import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import { createApiRequestHandler } from "./api";
import { AppModule } from "./nest/app.module";
import {
  attachRealtimeSocketServer,
  createRealtimeSocketServer,
  SocketIoQueueRealtimeBroadcaster,
} from "./realtime";
import { createAsyncJobsRuntime, createNoopAsyncJobsRuntime } from "./jobs";
import { loadRuntimeEnv } from "./runtime/env";

export interface RuntimeHandle {
  port: number;
  stop: () => Promise<void>;
}

export const bootstrap = async (): Promise<RuntimeHandle> => {
  const env = loadRuntimeEnv();

  const prismaClient = new PrismaClient();
  const realtimeSocketServer = createRealtimeSocketServer(
    prismaClient,
    env.jwtAccessTokenSecret,
    env.realtimeCorsAllowedOrigins
  );
  const realtimeBroadcaster = new SocketIoQueueRealtimeBroadcaster(
    realtimeSocketServer
  );
  const jobsRuntime = env.redisUrl
    ? createAsyncJobsRuntime(
        env.redisUrl,
        env.asyncJobsWorkerConcurrency,
        env.asyncJobsRetainCompletedJobs,
        env.asyncJobsRetainFailedJobs
      )
    : createNoopAsyncJobsRuntime();
  const requestHandler = createApiRequestHandler(prismaClient, {
    jwtAccessTokenSecret: env.jwtAccessTokenSecret,
    jwtRefreshTokenSecret: env.jwtRefreshTokenSecret,
    jwtAccessTokenExpiresInSeconds: env.jwtAccessTokenExpiresInSeconds,
    jwtRefreshTokenExpiresInSeconds: env.jwtRefreshTokenExpiresInSeconds,
  }, {
    realtimeBroadcaster,
  });
  const app = await NestFactory.create(AppModule.register(requestHandler), {
    bodyParser: false,
  });
  attachRealtimeSocketServer(realtimeSocketServer, app.getHttpServer());

  let prismaConnected = false;
  let jobsStarted = false;
  let jobsReady = false;
  let appListening = false;
  let realtimeServerAttached = true;
  let stopPromise: Promise<void> | null = null;

  const processEmitter = process as typeof process & {
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (
      event: string,
      listener: (...args: unknown[]) => void
    ) => void;
  };

  const unregisterSignalHandlers = (
    handler: (...args: unknown[]) => void
  ): void => {
    if (typeof processEmitter.off === "function") {
      processEmitter.off("SIGINT", handler);
      processEmitter.off("SIGTERM", handler);
      return;
    }

    if (typeof processEmitter.removeListener === "function") {
      processEmitter.removeListener("SIGINT", handler);
      processEmitter.removeListener("SIGTERM", handler);
    }
  };

  const shutdownResources = async (): Promise<void> => {
    if (appListening) {
      await app.close().catch(() => undefined);
    }

    if (realtimeServerAttached) {
      await realtimeSocketServer.close().catch(() => undefined);
      realtimeServerAttached = false;
    }

    if (jobsStarted) {
      await jobsRuntime.stop().catch(() => undefined);
      jobsStarted = false;
      jobsReady = false;
    }

    if (prismaConnected) {
      await prismaClient.$disconnect().catch(() => undefined);
    }
  };

  try {
    await prismaClient.$connect();
    prismaConnected = true;
    jobsStarted = true;
    await jobsRuntime.start();
    jobsReady = true;
    await app.listen(env.port);
    appListening = true;
    console.log(`[runtime] Smart Queue backend listening on port ${env.port}`);
  } catch (error: unknown) {
    await shutdownResources();
    throw error;
  }

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    unregisterSignalHandlers(onSignal);
    stopPromise = shutdownResources();
    return stopPromise;
  };

  const onSignal = (): void => {
    void stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    port: env.port,
    stop,
  };
};

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("[runtime] Failed to start Smart Queue backend", message);
    process.exit(1);
  });
}

export * from "./api";
export * from "./auth";
export * from "./jobs";
export * from "./queue-engine";
