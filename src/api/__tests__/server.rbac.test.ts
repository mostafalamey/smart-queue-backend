import { AppRole } from "@prisma/client";
import { __serverTestables } from "../server";

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

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[server-rbac] ${name} failed: ${reason}`);
  }
};

runTest("assertRoleAllowedByPolicy allows configured role", () => {
  __serverTestables.assertRoleAllowedByPolicy(
    {
      userId: "user-1",
      role: AppRole.STAFF,
      stationId: "station-1",
    },
    {
      allowedRoles: __serverTestables.TELLER_ROUTE_ALLOWED_ROLES,
    }
  );
});

runTest("assertRoleAllowedByPolicy rejects unconfigured role", () => {
  try {
    __serverTestables.assertRoleAllowedByPolicy(
      {
        userId: "user-2",
        role: AppRole.STAFF,
      },
      {
        allowedRoles: new Set<AppRole>([AppRole.ADMIN]),
      }
    );
    throw new Error("Expected role guard to reject staff role");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ok(
      message.includes("Authenticated role is not allowed for this route"),
      "expected forbidden role message"
    );
  }
});

runTest("mapPrincipalToQueueActor keeps principal identity and station binding", () => {
  const actor = __serverTestables.mapPrincipalToQueueActor({
    userId: "user-3",
    role: AppRole.MANAGER,
    stationId: "station-3",
  });

  equal(actor.actorType, "USER");
  equal(actor.actorUserId, "user-3");
  equal(actor.stationId, "station-3");
});
