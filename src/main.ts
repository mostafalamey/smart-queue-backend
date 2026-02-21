/// <reference path="./types/node-shim.d.ts" />

import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import { createApiRequestHandler } from "./api";
import { AppModule } from "./nest/app.module";
import { loadRuntimeEnv } from "./runtime/env";

export interface RuntimeHandle {
  port: number;
  stop: () => Promise<void>;
}

export const bootstrap = async (): Promise<RuntimeHandle> => {
  const env = loadRuntimeEnv();

  const prismaClient = new PrismaClient();
  const requestHandler = createApiRequestHandler(prismaClient, {
    jwtAccessTokenSecret: env.jwtAccessTokenSecret,
    jwtRefreshTokenSecret: env.jwtRefreshTokenSecret,
    jwtAccessTokenExpiresInSeconds: env.jwtAccessTokenExpiresInSeconds,
    jwtRefreshTokenExpiresInSeconds: env.jwtRefreshTokenExpiresInSeconds,
  });
  const app = await NestFactory.create(AppModule.register(requestHandler), {
    bodyParser: false,
  });

  let prismaConnected = false;
  let appListening = false;
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

    if (prismaConnected) {
      await prismaClient.$disconnect().catch(() => undefined);
    }
  };

  try {
    await prismaClient.$connect();
    prismaConnected = true;
    await app.listen(env.port);
    appListening = true;
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

export * from "./api";
export * from "./auth";
export * from "./queue-engine";
