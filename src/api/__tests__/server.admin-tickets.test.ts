/**
 * Tests for admin ticket management endpoints (Phase C — Queue Control).
 *
 * Covers:
 *  - RBAC enforcement: ADMIN + MANAGER allowed; STAFF + IT rejected
 *  - Manager department scoping on search, detail, lock, unlock, change-priority
 *  - Ticket search: happy path, short query rejection
 *  - Ticket detail: 200 success, 404 not found, manager scope 403
 *  - Lock: success, 409 conflict (locked by another user), non-WAITING rejection
 *  - Unlock: owner allowed, admin override allowed, non-owner manager rejected
 *  - Change-priority: lock ownership validation, auto-lock release
 *  - Priority categories: scoped to hospital
 */

import { AppRole } from "@prisma/client";
import { IncomingMessage, ServerResponse } from "node:http";
import { issueAuthTokens } from "../../auth/tokens";
import { createApiRequestHandler } from "../server";

// ── Test helpers ──────────────────────────────────────────────────────────────

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
};

const ok = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[admin-tickets] ${name} failed: ${reason}`);
  }
};

const securityConfig = {
  jwtAccessTokenSecret: "access-secret-for-admin-tickets-tests",
  jwtRefreshTokenSecret: "refresh-secret-for-admin-tickets-tests",
  jwtAccessTokenExpiresInSeconds: 900,
  jwtRefreshTokenExpiresInSeconds: 3600,
};

const createAccessToken = (userId: string, role: AppRole): string => {
  return issueAuthTokens(
    { userId, role },
    {
      jwtAccessTokenSecret: securityConfig.jwtAccessTokenSecret,
      jwtRefreshTokenSecret: securityConfig.jwtRefreshTokenSecret,
    }
  ).accessToken;
};

const createJsonRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  accessToken?: string
): IncomingMessage => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  return {
    method,
    url: path,
    headers,
    [Symbol.asyncIterator]: async function* () {
      if (body) {
        yield JSON.stringify(body);
      }
    },
  } as unknown as IncomingMessage;
};

const createResponseCollector = (): {
  response: ServerResponse;
  readJsonBody: () => Record<string, unknown>;
} => {
  let rawBody = "";
  const response = {
    statusCode: 200,
    setHeader: (_name: string, _value: string) => {
      return;
    },
    end: (value?: string) => {
      rawBody = value ?? "";
    },
  } as unknown as ServerResponse;

  return {
    response,
    readJsonBody: () => {
      if (!rawBody) return {};
      return JSON.parse(rawBody) as Record<string, unknown>;
    },
  };
};

// ── Shared mock data ──────────────────────────────────────────────────────────

const NOW = new Date("2026-03-05T10:00:00.000Z");

const TICKET_ROW = {
  id: "ticket-1",
  ticketNumber: "GEN-001",
  phoneNumber: "0512345678",
  status: "WAITING",
  sequenceNumber: 1,
  serviceId: "service-1",
  departmentId: "department-1",
  hospitalId: "hospital-1",
  priorityCategoryId: "priority-normal",
  priorityWeight: 0,
  calledAt: null,
  servingStartedAt: null,
  completedAt: null,
  noShowAt: null,
  cancelledAt: null,
  calledCounterStationId: null,
  lockedByUserId: null,
  lockedUntil: null,
  originTicketId: null,
  createdAt: NOW,
  updatedAt: NOW,
  priorityCategory: { weight: 0, nameEn: "Normal", nameAr: "عادي", code: "NORMAL" },
  service: { nameEn: "General", nameAr: "عام" },
  department: { nameEn: "Reception", nameAr: "الاستقبال" },
  events: [
    {
      id: "event-1",
      eventType: "CREATED",
      actorType: "KIOSK",
      actorUserId: null,
      stationId: null,
      payload: null,
      occurredAt: NOW,
    },
  ],
};

// ── Prisma mock factories ─────────────────────────────────────────────────────

/** Base prisma mock that resolves principal scope (admin with no manager department) */
const makeAdminPrisma = (overrides?: Record<string, unknown>) => {
  const base = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(base),
    user: {
      findUnique: async () => ({
        hospitalId: "hospital-1",
        roleAssignments: [],
      }),
    },
    ticket: {
      findMany: async () => [],
      findFirst: async () => null,
      update: async () => ({}),
    },
    ticketEvent: {
      create: async () => ({}),
    },
    priorityCategory: {
      findMany: async () => [],
    },
    ...overrides,
  };
  return base;
};

/** Prisma mock for a manager scoped to department-1 */
const makeManagerPrisma = (overrides?: Record<string, unknown>) => {
  return makeAdminPrisma({
    user: {
      findUnique: async () => ({
        hospitalId: "hospital-1",
        roleAssignments: [{ departmentId: "department-1" }],
      }),
    },
    ...overrides,
  });
};

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("admin-tickets tests:");

void (async () => {
  // ── RBAC enforcement ────────────────────────────────────────────────────

  await runTest("RBAC: STAFF is rejected from ticket search", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-staff", AppRole.STAFF);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=GEN", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: IT is rejected from ticket search", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-it", AppRole.IT);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=GEN", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: STAFF is rejected from ticket detail", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-staff", AppRole.STAFF);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/ticket-1", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: IT is rejected from lock endpoint", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-it", AppRole.IT);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: STAFF is rejected from unlock endpoint", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-staff", AppRole.STAFF);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/unlock", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: STAFF is rejected from change-priority endpoint", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-staff", AppRole.STAFF);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/tickets/ticket-1/change-priority",
        { priorityCategoryId: "cat-1", priorityWeight: 10 },
        token
      ),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: IT is rejected from priority-categories endpoint", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-it", AppRole.IT);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/priority-categories", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("RBAC: ADMIN is allowed on ticket search", async () => {
    const prisma = makeAdminPrisma({
      ticket: {
        findMany: async () => [{ ...TICKET_ROW }],
        findFirst: async () => null,
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=GEN", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    const body = readJsonBody();
    const tickets = body.tickets as unknown[];
    equal(tickets.length, 1);
  });

  await runTest("RBAC: MANAGER is allowed on ticket search", async () => {
    const prisma = makeManagerPrisma({
      ticket: {
        findMany: async () => [{ ...TICKET_ROW }],
        findFirst: async () => null,
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=GEN", undefined, token),
      response
    );

    equal(response.statusCode, 200);
  });

  // ── Ticket search validation ────────────────────────────────────────────

  await runTest("ticket search rejects query shorter than 2 characters", async () => {
    const prisma = makeAdminPrisma();
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=G", undefined, token),
      response
    );

    equal(response.statusCode, 400);
    equal(readJsonBody().code, "INVALID_REQUEST");
  });

  await runTest("ticket search applies manager department scope", async () => {
    let capturedWhere: Record<string, unknown> = {};
    const prisma = makeManagerPrisma({
      ticket: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          capturedWhere = args.where;
          return [];
        },
        findFirst: async () => null,
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/search?q=GEN", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    equal(capturedWhere.departmentId, "department-1", "manager search must be scoped to their department");
    equal(capturedWhere.hospitalId, "hospital-1", "search must be scoped to hospital");
  });

  // ── Ticket detail ───────────────────────────────────────────────────────

  await runTest("ticket detail returns 200 with full ticket for admin", async () => {
    const prisma = makeAdminPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => ({ ...TICKET_ROW }),
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/ticket-1", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    const body = readJsonBody();
    const ticket = body.ticket as Record<string, unknown>;
    equal(ticket.id, "ticket-1");
    equal(ticket.ticketNumber, "GEN-001");
    ok(typeof ticket.phoneNumber === "string", "phone should be present");
    ok(!(ticket.phoneNumber as string).includes("0512345678"), "phone should be masked");
  });

  await runTest("ticket detail returns 404 when ticket does not exist", async () => {
    const prisma = makeAdminPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => null,
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/nonexistent", undefined, token),
      response
    );

    equal(response.statusCode, 404);
    equal(readJsonBody().code, "NOT_FOUND");
  });

  await runTest("ticket detail rejects manager accessing another department's ticket", async () => {
    const prisma = makeManagerPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => ({ ...TICKET_ROW, departmentId: "department-2" }),
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/tickets/ticket-1", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
    ok(
      String(readJsonBody().message).includes("Manager access is limited"),
      "expected manager scope error message"
    );
  });

  // ── Lock endpoint ───────────────────────────────────────────────────────

  await runTest("lock succeeds for WAITING ticket", async () => {
    let updatedData: Record<string, unknown> = {};
    let eventCreated = false;
    const txMock = {
      ticket: {
        findFirst: async () => ({ ...TICKET_ROW }),
        update: async (args: { data: Record<string, unknown> }) => {
          updatedData = args.data;
          return {};
        },
      },
      ticketEvent: {
        create: async () => {
          eventCreated = true;
          return {};
        },
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    const body = readJsonBody();
    equal(body.ticketId, "ticket-1");
    equal(body.lockedByUserId, "user-admin");
    ok(typeof body.lockedUntil === "string", "lockedUntil should be an ISO string");
    equal(updatedData.lockedByUserId, "user-admin");
    ok(updatedData.lockedUntil instanceof Date, "lockedUntil should be a Date");
    equal(eventCreated, true, "LOCKED event should be recorded");
  });

  await runTest("lock returns 409 when locked by another user", async () => {
    const lockedUntil = new Date(NOW.getTime() + 120_000); // 2 minutes from NOW
    const txMock = {
      ticket: {
        findFirst: async () => ({
          ...TICKET_ROW,
          lockedByUserId: "other-user",
          lockedUntil,
        }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 409);
    const body = readJsonBody();
    equal(body.code, "TICKET_LOCKED");
    equal(body.lockedByUserId, "other-user");
    ok(typeof body.lockedUntil === "string", "lockedUntil should be present");
  });

  await runTest("lock rejects non-WAITING ticket (e.g. SERVING)", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => ({ ...TICKET_ROW, status: "SERVING" }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 400);
    equal(readJsonBody().code, "INVALID_REQUEST");
    ok(
      String(readJsonBody().message).includes("WAITING"),
      "error should mention WAITING requirement"
    );
  });

  await runTest("lock returns 404 when ticket does not exist", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => null,
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 404);
    equal(readJsonBody().code, "NOT_FOUND");
  });

  await runTest("lock enforces manager department scope", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => ({ ...TICKET_ROW, departmentId: "department-2" }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeManagerPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  await runTest("same user can re-lock their own ticket (extend lock)", async () => {
    const lockedUntil = new Date(NOW.getTime() + 60_000); // still valid
    const txMock = {
      ticket: {
        findFirst: async () => ({
          ...TICKET_ROW,
          lockedByUserId: "user-admin",
          lockedUntil,
        }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/lock", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    equal(readJsonBody().lockedByUserId, "user-admin");
  });

  // ── Unlock endpoint ─────────────────────────────────────────────────────

  await runTest("unlock succeeds for lock owner", async () => {
    let ticketUpdated = false;
    let eventCreated = false;
    const txMock = {
      ticket: {
        findFirst: async () => ({
          ...TICKET_ROW,
          lockedByUserId: "user-admin",
          lockedUntil: new Date(NOW.getTime() + 120_000),
        }),
        update: async () => {
          ticketUpdated = true;
          return {};
        },
      },
      ticketEvent: {
        create: async () => {
          eventCreated = true;
          return {};
        },
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/unlock", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    equal(readJsonBody().success, true);
    equal(ticketUpdated, true, "ticket lock fields should be cleared");
    equal(eventCreated, true, "UNLOCKED event should be recorded");
  });

  await runTest("unlock allows admin to unlock another user's lock", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => ({
          ...TICKET_ROW,
          lockedByUserId: "other-user",
          lockedUntil: new Date(NOW.getTime() + 120_000),
        }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/unlock", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    equal(readJsonBody().success, true);
  });

  await runTest("unlock rejects manager unlocking another user's lock", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => ({
          ...TICKET_ROW,
          lockedByUserId: "other-user",
          lockedUntil: new Date(NOW.getTime() + 120_000),
        }),
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeManagerPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/unlock", undefined, token),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
    ok(
      String(readJsonBody().message).includes("lock owner"),
      "expected lock ownership error message"
    );
  });

  await runTest("unlock returns 404 when ticket does not exist", async () => {
    const txMock = {
      ticket: {
        findFirst: async () => null,
        update: async () => ({}),
      },
      ticketEvent: {
        create: async () => ({}),
      },
    };

    const prisma = makeAdminPrisma({
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(txMock),
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("POST", "/admin/tickets/ticket-1/unlock", undefined, token),
      response
    );

    equal(response.statusCode, 404);
    equal(readJsonBody().code, "NOT_FOUND");
  });

  // ── Change-priority endpoint ────────────────────────────────────────────

  await runTest("change-priority rejects when ticket is locked by another user", async () => {
    const lockedTicketRow = {
      ...TICKET_ROW,
      lockedByUserId: "other-user",
      lockedUntil: new Date(NOW.getTime() + 120_000),
    };
    const prisma = makeAdminPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => lockedTicketRow,
        // getTicketLockState calls findUnique inside the queue engine transaction
        findUnique: async () => ({
          lockedByUserId: lockedTicketRow.lockedByUserId,
          lockedUntil: lockedTicketRow.lockedUntil,
        }),
        update: async () => ({}),
      },
      // getTicketForUpdate uses $queryRaw inside the queue engine transaction
      $queryRaw: async () => [
        {
          id: lockedTicketRow.id,
          hospitalId: lockedTicketRow.hospitalId,
          departmentId: lockedTicketRow.departmentId,
          serviceId: lockedTicketRow.serviceId,
          ticketDate: NOW,
          sequenceNumber: lockedTicketRow.sequenceNumber,
          ticketNumber: lockedTicketRow.ticketNumber,
          phoneNumber: lockedTicketRow.phoneNumber,
          priorityCategoryId: lockedTicketRow.priorityCategoryId,
          status: lockedTicketRow.status,
          calledAt: null,
          servingStartedAt: null,
          completedAt: null,
          noShowAt: null,
          cancelledAt: null,
          calledCounterStationId: null,
          originTicketId: null,
          createdAt: NOW,
          updatedAt: NOW,
          priorityWeight: 0,
        },
      ],
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/tickets/ticket-1/change-priority",
        { priorityCategoryId: "cat-urgent", priorityWeight: 10 },
        token
      ),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
    ok(
      String(readJsonBody().message).includes("locked by another user"),
      "expected lock conflict message"
    );
  });

  await runTest("change-priority returns 404 when ticket does not exist", async () => {
    const prisma = makeAdminPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => null,
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/tickets/ticket-1/change-priority",
        { priorityCategoryId: "cat-1", priorityWeight: 5 },
        token
      ),
      response
    );

    equal(response.statusCode, 404);
    equal(readJsonBody().code, "NOT_FOUND");
  });

  await runTest("change-priority enforces manager department scope", async () => {
    const prisma = makeManagerPrisma({
      ticket: {
        findMany: async () => [],
        findFirst: async () => ({ ...TICKET_ROW, departmentId: "department-2" }),
        update: async () => ({}),
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/tickets/ticket-1/change-priority",
        { priorityCategoryId: "cat-1", priorityWeight: 5 },
        token
      ),
      response
    );

    equal(response.statusCode, 403);
    equal(readJsonBody().code, "FORBIDDEN");
  });

  // ── Priority categories ─────────────────────────────────────────────────

  await runTest("priority-categories returns list scoped to hospital", async () => {
    let capturedWhere: Record<string, unknown> = {};
    const prisma = makeAdminPrisma({
      priorityCategory: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          capturedWhere = args.where;
          return [
            { id: "cat-1", code: "URGENT", nameEn: "Urgent", nameAr: "عاجل", weight: 10 },
            { id: "cat-2", code: "NORMAL", nameEn: "Normal", nameAr: "عادي", weight: 0 },
          ];
        },
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-admin", AppRole.ADMIN);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/priority-categories", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    const body = readJsonBody();
    const categories = body.categories as unknown[];
    equal(categories.length, 2);
    equal(capturedWhere.hospitalId, "hospital-1", "categories must be scoped by hospital");
  });

  await runTest("MANAGER is allowed to read priority-categories", async () => {
    const prisma = makeManagerPrisma({
      priorityCategory: {
        findMany: async () => [
          { id: "cat-1", code: "NORMAL", nameEn: "Normal", nameAr: "عادي", weight: 0 },
        ],
      },
    });
    const handler = createApiRequestHandler(prisma as never, securityConfig);
    const token = createAccessToken("user-manager", AppRole.MANAGER);

    const { response, readJsonBody } = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/priority-categories", undefined, token),
      response
    );

    equal(response.statusCode, 200);
    const body = readJsonBody();
    const categories = body.categories as unknown[];
    equal(categories.length, 1);
  });

  console.log("\n  All admin-tickets tests passed ✓");
})();
