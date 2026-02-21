import { AppRole } from "@prisma/client";
import { IncomingMessage, ServerResponse } from "node:http";
import { issueAuthTokens } from "../../auth/tokens";
import { createApiRequestHandler } from "../server";

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

const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[server-admin-config-persistence] ${name} failed: ${reason}`);
  }
};

const securityConfig = {
  jwtAccessTokenSecret: "access-secret-for-admin-config-tests",
  jwtRefreshTokenSecret: "refresh-secret-for-admin-config-tests",
  jwtAccessTokenExpiresInSeconds: 900,
  jwtRefreshTokenExpiresInSeconds: 3600,
};

const createAccessToken = (userId: string, role: AppRole): string => {
  return issueAuthTokens(
    {
      userId,
      role,
    },
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
      if (!rawBody) {
        return {};
      }

      return JSON.parse(rawBody) as Record<string, unknown>;
    },
  };
};

void (async () => {
  await runTest("templates endpoints enforce hospital scoping on read/write", async () => {
    const calls: {
      findManyWhere?: unknown;
      upsertWhere?: unknown;
      upsertCreate?: unknown;
      auditCreate?: unknown;
    } = {};

    const prismaClient = {
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(prismaClient),
      user: {
        findUnique: async () => ({
          hospitalId: "hospital-1",
          roleAssignments: [],
        }),
      },
      messageTemplate: {
        findMany: async (args: { where: unknown }) => {
          calls.findManyWhere = args.where;
          return [];
        },
        upsert: async (args: { where: unknown; create: unknown }) => {
          calls.upsertWhere = args.where;
          calls.upsertCreate = args.create;
          return {
            id: "template-1",
            channel: "WHATSAPP",
            eventType: "TICKET_CALLED",
            language: "en",
            content: "Your ticket was called",
            isActive: true,
            updatedAt: new Date(),
          };
        },
      },
      auditLog: {
        create: async (args: { data: unknown }) => {
          calls.auditCreate = args.data;
          return {
            id: "audit-1",
          };
        },
      },
    } as unknown;

    const handler = createApiRequestHandler(prismaClient as never, securityConfig);
    const accessToken = createAccessToken("user-admin", AppRole.ADMIN);

    const read = createResponseCollector();
    await handler(
      createJsonRequest("GET", "/admin/config/templates", undefined, accessToken),
      read.response
    );
    equal(read.response.statusCode, 200);

    const write = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/config/templates",
        {
          templateKey: "TICKET_CALLED",
          language: "en",
          content: "Your ticket was called",
        },
        accessToken
      ),
      write.response
    );
    equal(write.response.statusCode, 200);

    const readWhere = calls.findManyWhere as { hospitalId?: string };
    equal(readWhere.hospitalId, "hospital-1", "template read must be scoped by principal hospital");

    const writeWhere = calls.upsertWhere as {
      hospitalId_channel_eventType_language?: {
        hospitalId?: string;
      };
    };
    equal(
      writeWhere.hospitalId_channel_eventType_language?.hospitalId,
      "hospital-1",
      "template write where clause must use principal hospital"
    );

    const writeCreate = calls.upsertCreate as { hospitalId?: string };
    equal(
      writeCreate.hospitalId,
      "hospital-1",
      "template create payload must use principal hospital"
    );

    const auditCreate = calls.auditCreate as { hospitalId?: string };
    equal(auditCreate.hospitalId, "hospital-1", "template write audit must use principal hospital");
  });

  await runTest("manager reset endpoint enforces assigned department scope", async () => {
    let auditCalled = false;

    const prismaClient = {
      user: {
        findUnique: async () => ({
          hospitalId: "hospital-1",
          roleAssignments: [
            {
              departmentId: "department-1",
            },
          ],
        }),
      },
      service: {
        findFirst: async () => ({
          id: "service-1",
          departmentId: "department-2",
          ticketPrefix: "LAB",
        }),
      },
      auditLog: {
        create: async () => {
          auditCalled = true;
          return {
            id: "audit-2",
          };
        },
      },
    } as unknown;

    const handler = createApiRequestHandler(prismaClient as never, securityConfig);
    const accessToken = createAccessToken("user-manager", AppRole.MANAGER);

    const response = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/config/resets/service-counter",
        {
          serviceId: "service-1",
        },
        accessToken
      ),
      response.response
    );

    equal(response.response.statusCode, 403);
    const body = response.readJsonBody();
    equal(body.code, "FORBIDDEN");
    ok(
      String(body.message).includes("Manager access is limited to the assigned department"),
      "expected manager scope forbidden message"
    );
    equal(auditCalled, false, "audit log should not be created when manager scope check fails");
  });

  await runTest("manager reset endpoint rejects manager without department assignment", async () => {
    let serviceLookupCalled = false;

    const prismaClient = {
      user: {
        findUnique: async () => ({
          hospitalId: "hospital-1",
          roleAssignments: [],
        }),
      },
      service: {
        findFirst: async () => {
          serviceLookupCalled = true;
          return null;
        },
      },
    } as unknown;

    const handler = createApiRequestHandler(prismaClient as never, securityConfig);
    const accessToken = createAccessToken("user-manager-no-assignment", AppRole.MANAGER);

    const response = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/config/resets/service-counter",
        {
          serviceId: "service-1",
        },
        accessToken
      ),
      response.response
    );

    equal(response.response.statusCode, 403);
    const body = response.readJsonBody();
    equal(body.code, "FORBIDDEN");
    ok(
      String(body.message).includes("Manager role assignment must be scoped to exactly one department"),
      "expected manager single-department assignment error"
    );
    equal(serviceLookupCalled, false, "service lookup should not run when manager assignment is invalid");
  });

  await runTest("manager reset endpoint rejects manager with multiple department assignments", async () => {
    let serviceLookupCalled = false;

    const prismaClient = {
      user: {
        findUnique: async () => ({
          hospitalId: "hospital-1",
          roleAssignments: [
            {
              departmentId: "department-1",
            },
            {
              departmentId: "department-2",
            },
          ],
        }),
      },
      service: {
        findFirst: async () => {
          serviceLookupCalled = true;
          return null;
        },
      },
    } as unknown;

    const handler = createApiRequestHandler(prismaClient as never, securityConfig);
    const accessToken = createAccessToken("user-manager-multi-assignment", AppRole.MANAGER);

    const response = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/config/resets/service-counter",
        {
          serviceId: "service-1",
        },
        accessToken
      ),
      response.response
    );

    equal(response.response.statusCode, 403);
    const body = response.readJsonBody();
    equal(body.code, "FORBIDDEN");
    ok(
      String(body.message).includes("Manager role assignment must be scoped to exactly one department"),
      "expected manager single-department assignment error"
    );
    equal(serviceLookupCalled, false, "service lookup should not run when manager assignment is invalid");
  });

  await runTest("retention write persists audit log on success", async () => {
    const calls: {
      retentionAudit?: { data: { action?: string; hospitalId?: string; after?: unknown } };
    } = {};

    const occurredAt = new Date("2026-02-21T12:00:00.000Z");

    const prismaClient = {
      user: {
        findUnique: async () => ({
          hospitalId: "hospital-2",
          roleAssignments: [],
        }),
      },
      auditLog: {
        create: async (args: { data: { action?: string; hospitalId?: string; after?: unknown } }) => {
          calls.retentionAudit = args;
          return {
            occurredAt,
          };
        },
      },
    } as unknown;

    const handler = createApiRequestHandler(prismaClient as never, securityConfig);
    const accessToken = createAccessToken("user-it", AppRole.IT);

    const response = createResponseCollector();
    await handler(
      createJsonRequest(
        "POST",
        "/admin/config/retention",
        {
          retentionDays: 120,
        },
        accessToken
      ),
      response.response
    );

    equal(response.response.statusCode, 200);

    const auditInput = calls.retentionAudit?.data;
    equal(auditInput?.action, "RETENTION_POLICY_UPDATED");
    equal(auditInput?.hospitalId, "hospital-2");

    const after = auditInput?.after as { retentionDays?: number };
    equal(after.retentionDays, 120);

    const body = response.readJsonBody();
    const retentionPolicy = body.retentionPolicy as { retentionDays?: number; updatedAt?: string };
    equal(retentionPolicy.retentionDays, 120);
    equal(retentionPolicy.updatedAt, occurredAt.toISOString());
  });
})();
