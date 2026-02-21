import { PrismaClient } from "@prisma/client";
import { createApiServer } from "./api";
import { loadRuntimeEnv } from "./runtime/env";

export interface RuntimeHandle {
  port: number;
  stop: () => Promise<void>;
}

const listen = (
  server: { listen: (port: number, callback?: () => void) => void },
  port: number
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const emitter = server as unknown as {
      once?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (
        event: string,
        handler: (...args: unknown[]) => void
      ) => void;
    };

    const onError = (error: unknown): void => {
      if (typeof emitter.removeListener === "function") {
        emitter.removeListener("listening", onListening);
      }
      reject(error);
    };

    const onListening = (): void => {
      if (typeof emitter.removeListener === "function") {
        emitter.removeListener("error", onError);
      }
      resolve();
    };

    if (typeof emitter.once === "function") {
      emitter.once("error", onError);
      emitter.once("listening", onListening);
    }

    try {
      server.listen(port);
    } catch (error: unknown) {
      if (typeof emitter.removeListener === "function") {
        emitter.removeListener("error", onError);
        emitter.removeListener("listening", onListening);
      }
      reject(error);
    }
  });
};

const close = (
  server: { close: (callback?: () => void) => void }
): Promise<void> => {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
};

export const bootstrap = async (): Promise<RuntimeHandle> => {
  const env = loadRuntimeEnv();

  const prismaClient = new PrismaClient();
  const apiServer = createApiServer(prismaClient);
  let prismaConnected = false;

  const shutdownResources = async (): Promise<void> => {
    await close(apiServer).catch(() => undefined);

    if (prismaConnected) {
      await prismaClient.$disconnect().catch(() => undefined);
    }
  };

  try {
    await prismaClient.$connect();
    prismaConnected = true;
    await listen(apiServer, env.port);
  } catch (error: unknown) {
    await shutdownResources();
    throw error;
  }

  const stop = async (): Promise<void> => {
    await shutdownResources();
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
export * from "./queue-engine";
