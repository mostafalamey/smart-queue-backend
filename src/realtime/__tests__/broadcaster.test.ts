import { AppRole, PrismaClient } from "@prisma/client";
import {
  NoopQueueRealtimeBroadcaster,
  SocketIoQueueRealtimeBroadcaster,
  __realtimeTestables,
} from "../broadcaster";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const ok = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runTest = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[realtime-broadcaster] ${name} failed: ${reason}`);
  }
};

type GlobalEmit = {
  event: string;
  payload: unknown;
};

type RoomEmit = {
  rooms: string[];
  event: string;
  payload: unknown;
};

const createSocketServerSpy = (): {
  socketServer: unknown;
  globalEmits: GlobalEmit[];
  roomEmits: RoomEmit[];
} => {
  const globalEmits: GlobalEmit[] = [];
  const roomEmits: RoomEmit[] = [];

  const createRoomEmitter = (rooms: string[]) => ({
    to: (nextRoom: string) => createRoomEmitter([...rooms, nextRoom]),
    emit: (event: string, payload: unknown) => {
      roomEmits.push({ rooms, event, payload });
    },
  });

  const socketServer = {
    emit: (event: string, payload: unknown) => {
      globalEmits.push({ event, payload });
    },
    to: (room: string) => createRoomEmitter([room]),
  };

  return {
    socketServer,
    globalEmits,
    roomEmits,
  };
};

const createPrincipal = (overrides?: Partial<{ userId: string; role: AppRole; stationId?: string }>) => {
  return {
    userId: overrides?.userId ?? "user-1",
    role: overrides?.role ?? AppRole.STAFF,
    stationId: overrides?.stationId,
  };
};

void (async () => {
  await runTest("NoopQueueRealtimeBroadcaster methods are no-op", () => {
    const broadcaster = new NoopQueueRealtimeBroadcaster();

    broadcaster.broadcastQueueUpdated({
      requestId: "req-1",
      operation: "op-1",
      occurredAt: new Date().toISOString(),
    });

    broadcaster.broadcastNowServingUpdated({
      requestId: "req-2",
      operation: "op-2",
      occurredAt: new Date().toISOString(),
    });
  });

  await runTest("broadcastQueueUpdated emits only to service room when serviceId exists", () => {
    const spy = createSocketServerSpy();
    const broadcaster = new SocketIoQueueRealtimeBroadcaster(
      spy.socketServer as never
    );

    const event = {
      requestId: "req-queue",
      operation: "teller.call-next",
      serviceId: "service-1",
      occurredAt: new Date().toISOString(),
    };

    broadcaster.broadcastQueueUpdated(event);

    equal(spy.globalEmits.length, 0, "global emit should not be used when room target exists");
    equal(spy.roomEmits.length, 1);
    equal(spy.roomEmits[0].rooms[0], "service:service-1");
    equal(spy.roomEmits[0].event, "queue.updated");
    equal(spy.roomEmits[0].payload, event);
  });

  await runTest("broadcastNowServingUpdated emits once to union of service and station rooms", () => {
    const spy = createSocketServerSpy();
    const broadcaster = new SocketIoQueueRealtimeBroadcaster(
      spy.socketServer as never
    );

    const event = {
      requestId: "req-now",
      operation: "teller.start-serving",
      serviceId: "service-1",
      stationId: "station-9",
      occurredAt: new Date().toISOString(),
    };

    broadcaster.broadcastNowServingUpdated(event);

    equal(spy.globalEmits.length, 0, "global emit should not be used when room targets exist");
    equal(spy.roomEmits.length, 1, "should emit once with room union targeting");
    equal(spy.roomEmits[0].rooms[0], "service:service-1");
    equal(spy.roomEmits[0].rooms[1], "station:station-9");
    equal(spy.roomEmits[0].event, "now-serving.updated");
    equal(spy.roomEmits[0].payload, event);
  });

  await runTest("isServiceAccessAllowed enforces active-service and manager assignment", async () => {
    const prismaClient = {
      service: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === "service-active") {
            return {
              departmentId: "dept-1",
              isActive: true,
            };
          }

          return null;
        },
      },
      roleAssignment: {
        findFirst: async ({ where }: { where: { userId: string; role: AppRole; departmentId: string } }) => {
          if (
            where.userId === "manager-1" &&
            where.role === AppRole.MANAGER &&
            where.departmentId === "dept-1"
          ) {
            return { id: "assignment-1" };
          }

          return null;
        },
      },
    } as unknown as PrismaClient;

    const allowed = await __realtimeTestables.isServiceAccessAllowed(
      prismaClient,
      createPrincipal({ userId: "manager-1", role: AppRole.MANAGER }),
      "service-active"
    );

    const denied = await __realtimeTestables.isServiceAccessAllowed(
      prismaClient,
      createPrincipal({ userId: "manager-2", role: AppRole.MANAGER }),
      "service-active"
    );

    const missingService = await __realtimeTestables.isServiceAccessAllowed(
      prismaClient,
      createPrincipal({ userId: "manager-1", role: AppRole.MANAGER }),
      "missing-service"
    );

    equal(allowed, true);
    equal(denied, false);
    equal(missingService, false);
  });

  await runTest("isStationAccessAllowed enforces staff station match and active station", async () => {
    const prismaClient = {
      counterStation: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === "station-active") {
            return {
              id: "station-active",
              isActive: true,
              service: {
                departmentId: "dept-1",
              },
            };
          }

          if (where.id === "station-inactive") {
            return {
              id: "station-inactive",
              isActive: false,
              service: {
                departmentId: "dept-1",
              },
            };
          }

          return null;
        },
      },
    } as unknown as PrismaClient;

    const allowed = await __realtimeTestables.isStationAccessAllowed(
      prismaClient,
      createPrincipal({ role: AppRole.STAFF, stationId: "station-active" }),
      "station-active"
    );

    const deniedByMismatch = await __realtimeTestables.isStationAccessAllowed(
      prismaClient,
      createPrincipal({ role: AppRole.STAFF, stationId: "other-station" }),
      "station-active"
    );

    const deniedByInactive = await __realtimeTestables.isStationAccessAllowed(
      prismaClient,
      createPrincipal({ role: AppRole.STAFF, stationId: "station-inactive" }),
      "station-inactive"
    );

    equal(allowed, true);
    equal(deniedByMismatch, false);
    equal(deniedByInactive, false);
  });

  ok(true, "realtime broadcaster tests completed");
})();
