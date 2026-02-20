import { PrismaClient } from "@prisma/client";
import { QueueEngineService } from "./service";
import { PrismaQueueEngineRepository } from "./prisma-repository";

export interface QueueEngineDependencies {
  prismaClient: PrismaClient;
}

export const createQueueEngineService = (
  dependencies: QueueEngineDependencies
): QueueEngineService => {
  const repository = new PrismaQueueEngineRepository(dependencies.prismaClient);
  return new QueueEngineService(repository);
};
