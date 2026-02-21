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
  return new Promise((resolve) => {
    server.listen(port, () => resolve());
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
  await prismaClient.$connect();

  const apiServer = createApiServer(prismaClient);
  await listen(apiServer, env.port);

  const stop = async (): Promise<void> => {
    await close(apiServer);
    await prismaClient.$disconnect();
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
