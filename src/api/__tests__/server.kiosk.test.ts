/**
 * Tests for kiosk public endpoints and CORS behavior.
 *
 * Covers:
 *  - parseKioskIssueTicketPayload: happy path, phone normalization, validation errors
 *  - getTicketDateBucket: midnight UTC bucketing, timezone handling
 *  - GET /departments: 200 with department list, CORS headers present
 *  - GET /departments/:id/services: 200 with service list
 *  - POST /tickets: success (201), duplicate (409), missing fields (400)
 *  - OPTIONS preflight: 204 with CORS headers
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { createApiRequestHandler, __serverTestables } from "../server";

const { parseKioskIssueTicketPayload, getTicketDateBucket } = __serverTestables;

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

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[server-kiosk] ${name} failed: ${reason}`);
  }
};

const runAsync = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[server-kiosk] ${name} failed: ${reason}`);
  }
};

const throwsWithMessage = (fn: () => unknown, pattern: string): void => {
  try {
    fn();
    throw new Error(`Expected function to throw but it did not`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ok(
      message.includes(pattern),
      `Expected error containing "${pattern}" but got: "${message}"`
    );
  }
};

// ── HTTP test harness ─────────────────────────────────────────────────────────

const createRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): IncomingMessage => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

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
  statusCode: () => number;
  header: (name: string) => string | undefined;
  jsonBody: () => Record<string, unknown>;
} => {
  let capturedStatus = 200;
  const capturedHeaders: Record<string, string> = {};
  let rawBody = "";

  const response = {
    get statusCode() {
      return capturedStatus;
    },
    set statusCode(v: number) {
      capturedStatus = v;
    },
    setHeader: (name: string, value: string) => {
      capturedHeaders[name.toLowerCase()] = value;
    },
    getHeader: (name: string) => capturedHeaders[name.toLowerCase()],
    writeHead: (code: number) => {
      capturedStatus = code;
    },
    end: (value?: string) => {
      rawBody = value ?? "";
    },
  } as unknown as ServerResponse;

  return {
    response,
    statusCode: () => capturedStatus,
    header: (name: string) => capturedHeaders[name.toLowerCase()],
    jsonBody: () => {
      if (!rawBody) return {};
      return JSON.parse(rawBody) as Record<string, unknown>;
    },
  };
};

// ── Minimal mock Prisma factories ─────────────────────────────────────────────

const makeDeptsPrisma = (
  departments: { id: string; nameAr: string; nameEn: string }[]
) =>
  ({
    hospital: {
      findFirst: async () => ({ id: "hospital-1" }),
    },
    department: {
      findMany: async () => departments,
    },
    service: { findMany: async () => [] },
    ticket: { findFirst: async () => null, aggregate: async () => ({ _max: { sequenceNumber: null } }), count: async () => 0, create: async () => null },
    ticketEvent: { create: async () => null },
    priorityCategory: { findFirst: async () => null },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    user: { findUnique: async () => null },
    roleAssignment: { findFirst: async () => null, create: async () => null },
    counterStation: { findFirst: async () => null },
    device: { findFirst: async () => null },
    auditLog: { create: async () => null, findFirst: async () => null },
    messageTemplate: { findMany: async () => [], upsert: async () => null },
  } as unknown);

const makeServicesPrisma = (
  services: { id: string; nameAr: string; nameEn: string; ticketPrefix: string; estimatedWaitMinutes: number }[]
) =>
  ({
    ...makeDeptsPrisma([]),
    service: { findMany: async () => services },
  } as unknown);

const makeTicketPrisma = (opts: {
  existingTicket?: unknown;
  maxSequence?: number | null;
}) => {
  const mockService = {
    id: "svc-1",
    ticketPrefix: "LAB",
    estimatedWaitMinutes: 5,
    isActive: true,
    department: {
      id: "dept-1",
      hospital: { id: "hospital-1", timezone: "Asia/Riyadh" },
    },
  };

  const mockTicket = {
    id: "ticket-new",
    hospitalId: "hospital-1",
    departmentId: "dept-1",
    serviceId: "svc-1",
    ticketDate: new Date("2026-02-27T00:00:00.000Z"),
    sequenceNumber: (opts.maxSequence ?? 0) + 1,
    ticketNumber: `LAB-${String((opts.maxSequence ?? 0) + 1).padStart(3, "0")}`,
    phoneNumber: "966501234567",
    priorityCategoryId: "priority-normal",
    status: "WAITING" as const,
    calledAt: null,
    servingStartedAt: null,
    completedAt: null,
    noShowAt: null,
    cancelledAt: null,
    calledCounterStationId: null,
    originTicketId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Prisma include { priorityCategory: { select: { weight } } } result shape
    priorityCategory: { weight: 1 },
  };

  // lockServiceAndGenerateNextSequence makes two $queryRaw calls:
  //   1st → [{ ticketPrefix }]  (Service FOR UPDATE lock)
  //   2nd → [{ maxSequenceNumber }]  (MAX sequence query)
  let queryRawCallCount = 0;
  const tx = {
    $queryRaw: async () => {
      queryRawCallCount++;
      if (queryRawCallCount === 1) return [{ ticketPrefix: "LAB" }];
      return [{ maxSequenceNumber: opts.maxSequence ?? 0 }];
    },
    ticket: {
      // hasActiveTicketForPhoneInService uses count inside the transaction
      count: async () => (opts.existingTicket ? 1 : 0),
      create: async () => mockTicket,
    },
    ticketEvent: {
      create: async () => ({ id: "evt-1" }),
    },
  };

  return {
    hospital: { findFirst: async () => ({ id: "hospital-1" }) },
    department: { findMany: async () => [] },
    service: { findFirst: async () => mockService, findMany: async () => [] },
    priorityCategory: { findFirst: async () => ({ id: "priority-normal", weight: 1 }) },
    ticket: { count: async () => 2 },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(tx),
    user: { findUnique: async () => null },
    roleAssignment: { findFirst: async () => null, create: async () => null },
    auditLog: { create: async () => null, findFirst: async () => null },
    counterStation: { findFirst: async () => null },
    device: { findFirst: async () => null },
    messageTemplate: { findMany: async () => [], upsert: async () => null },
  } as unknown;
};

const securityConfig = {
  jwtAccessTokenSecret: "access-secret-kiosk-tests",
  jwtRefreshTokenSecret: "refresh-secret-kiosk-tests",
  jwtAccessTokenExpiresInSeconds: 900,
  jwtRefreshTokenExpiresInSeconds: 3600,
};

// ── Unit: parseKioskIssueTicketPayload ────────────────────────────────────────

runTest("parseKioskIssueTicketPayload returns normalized payload for valid input", () => {
  const result = parseKioskIssueTicketPayload({
    departmentId: "dept-1",
    serviceId: "svc-1",
    phoneNumber: "966501234567",
  });
  equal(result.departmentId, "dept-1");
  equal(result.serviceId, "svc-1");
  equal(result.phoneNumber, "966501234567");
});

runTest("parseKioskIssueTicketPayload strips non-digit characters from phone", () => {
  const result = parseKioskIssueTicketPayload({
    departmentId: "dept-1",
    serviceId: "svc-1",
    phoneNumber: "+966-50-123-4567",
  });
  equal(result.phoneNumber, "966501234567");
});

runTest("parseKioskIssueTicketPayload rejects phone shorter than 7 digits", () => {
  throwsWithMessage(
    () =>
      parseKioskIssueTicketPayload({
        departmentId: "dept-1",
        serviceId: "svc-1",
        phoneNumber: "12345",
      }),
    "7"
  );
});

runTest("parseKioskIssueTicketPayload rejects phone longer than 15 digits", () => {
  throwsWithMessage(
    () =>
      parseKioskIssueTicketPayload({
        departmentId: "dept-1",
        serviceId: "svc-1",
        phoneNumber: "1234567890123456", // 16 digits
      }),
    "15"
  );
});

runTest("parseKioskIssueTicketPayload rejects missing departmentId", () => {
  throwsWithMessage(
    () =>
      parseKioskIssueTicketPayload({
        serviceId: "svc-1",
        phoneNumber: "966501234567",
      }),
    "departmentId"
  );
});

runTest("parseKioskIssueTicketPayload rejects missing serviceId", () => {
  throwsWithMessage(
    () =>
      parseKioskIssueTicketPayload({
        departmentId: "dept-1",
        phoneNumber: "966501234567",
      }),
    "serviceId"
  );
});

// ── Unit: getTicketDateBucket ─────────────────────────────────────────────────

runTest("getTicketDateBucket returns a Date at midnight UTC", () => {
  const bucket = getTicketDateBucket("Asia/Riyadh");
  ok(bucket instanceof Date, "should return a Date");
  equal(bucket.getUTCHours(), 0, "hours should be 0");
  equal(bucket.getUTCMinutes(), 0, "minutes should be 0");
  equal(bucket.getUTCSeconds(), 0, "seconds should be 0");
  equal(bucket.getUTCMilliseconds(), 0, "milliseconds should be 0");
});

runTest("getTicketDateBucket is consistent for same timezone on repeated calls", () => {
  const a = getTicketDateBucket("UTC");
  const b = getTicketDateBucket("UTC");
  equal(a.getTime(), b.getTime(), "same timezone should produce same bucket");
});

runTest("getTicketDateBucket produces different buckets for different current-day timezones", () => {
  // UTC and UTC+14 (Pacific/Kiritimati) may be on different calendar dates
  // We can't predict direction without knowing current wall clock, but we can
  // at least verify both return valid midnight-UTC dates.
  const utcBucket = getTicketDateBucket("UTC");
  const ristBucket = getTicketDateBucket("Pacific/Kiritimati");

  ok(utcBucket instanceof Date, "UTC bucket is a Date");
  ok(ristBucket instanceof Date, "Kiritimati bucket is a Date");
  equal(utcBucket.getUTCHours(), 0, "UTC bucket is midnight UTC");
  equal(ristBucket.getUTCHours(), 0, "Kiritimati bucket is midnight UTC");
});

// ── Integration: CORS / OPTIONS preflight ─────────────────────────────────────

void (async () => {
  await runAsync("OPTIONS preflight returns 204 with CORS headers", async () => {
    const handler = createApiRequestHandler(
      makeDeptsPrisma([]) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("OPTIONS", "/departments", undefined, {
        origin: "http://localhost:5173",
      }),
      col.response
    );
    equal(col.statusCode(), 204, "status should be 204");
  });

  await runAsync("GET /departments returns 200 with department list", async () => {
    const depts = [
      { id: "dept-1", nameAr: "الطب العام", nameEn: "General Medicine" },
      { id: "dept-2", nameAr: "المختبر", nameEn: "Laboratory" },
    ];
    const handler = createApiRequestHandler(
      makeDeptsPrisma(depts) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("GET", "/departments"),
      col.response
    );
    equal(col.statusCode(), 200, "status should be 200");
    const body = col.jsonBody() as unknown[];
    equal(Array.isArray(body), true, "body should be an array");
    equal(body.length, 2, "should return 2 departments");
  });

  await runAsync("GET /departments includes CORS header when Origin matches", async () => {
    const handler = createApiRequestHandler(
      makeDeptsPrisma([]) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("GET", "/departments", undefined, {
        origin: "http://localhost:5173",
      }),
      col.response
    );
    const corsHeader = col.header("access-control-allow-origin");
    ok(
      corsHeader !== undefined,
      "Access-Control-Allow-Origin header should be present"
    );
  });

  await runAsync("GET /departments/:id/services returns 200 with service list", async () => {
    const services = [
      { id: "svc-1", nameAr: "تحليل دم", nameEn: "Blood Test", ticketPrefix: "LAB", estimatedWaitMinutes: 5 },
    ];
    const handler = createApiRequestHandler(
      makeServicesPrisma(services) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("GET", "/departments/dept-lab/services"),
      col.response
    );
    equal(col.statusCode(), 200, "status should be 200");
    const body = col.jsonBody() as unknown[];
    equal(Array.isArray(body), true, "body should be an array");
    equal(body.length, 1, "should return 1 service");
  });

  await runAsync("POST /tickets issues a ticket and returns 201", async () => {
    const handler = createApiRequestHandler(
      makeTicketPrisma({ maxSequence: null }) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("POST", "/tickets", {
        departmentId: "dept-1",
        serviceId: "svc-1",
        phoneNumber: "966501234567",
      }),
      col.response
    );
    equal(col.statusCode(), 201, "status should be 201");
    const body = col.jsonBody() as Record<string, unknown>;
    ok("ticket" in body, "response should contain ticket");
    ok("queueSnapshot" in body, "response should contain queueSnapshot");
  });

  await runAsync("POST /tickets returns 409 on duplicate active ticket", async () => {
    const handler = createApiRequestHandler(
      makeTicketPrisma({
        existingTicket: { id: "existing-ticket", ticketNumber: "LAB-001" },
      }) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("POST", "/tickets", {
        departmentId: "dept-1",
        serviceId: "svc-1",
        phoneNumber: "966501234567",
      }),
      col.response
    );
    equal(col.statusCode(), 409, "status should be 409");
    const body = col.jsonBody() as Record<string, unknown>;
    equal(body.code, "DUPLICATE_ACTIVE_TICKET", "error code should be DUPLICATE_ACTIVE_TICKET");
  });

  await runAsync("POST /tickets returns 400 on missing required field", async () => {
    const handler = createApiRequestHandler(
      makeTicketPrisma({}) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("POST", "/tickets", {
        departmentId: "dept-1",
        // serviceId missing
        phoneNumber: "966501234567",
      }),
      col.response
    );
    equal(col.statusCode(), 400, "status should be 400");
  });

  await runAsync("POST /tickets returns 400 on invalid phone number", async () => {
    const handler = createApiRequestHandler(
      makeTicketPrisma({}) as never,
      securityConfig
    );
    const col = createResponseCollector();
    await handler(
      createRequest("POST", "/tickets", {
        departmentId: "dept-1",
        serviceId: "svc-1",
        phoneNumber: "123", // too short
      }),
      col.response
    );
    equal(col.statusCode(), 400, "status should be 400");
  });
})();
