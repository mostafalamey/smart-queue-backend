import { AppRole } from "@prisma/client";
import {
  RefreshError,
  logoutWithRefreshTokenSkeleton,
  refreshAuthTokens,
} from "../refresh";
import { issueAuthTokens } from "../tokens";

interface RoleAssignmentRecord {
  role: AppRole;
  departmentId: string | null;
}

interface UserRecord {
  id: string;
  email: string;
  isActive: boolean;
  mustChangePassword: boolean;
  roleAssignments: RoleAssignmentRecord[];
}

const tokenConfig = {
  jwtAccessTokenSecret: "access-secret",
  jwtRefreshTokenSecret: "refresh-secret",
  accessTokenExpiresInSeconds: 900,
  refreshTokenExpiresInSeconds: 604800,
};

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

const createUser = (overrides: Partial<UserRecord> = {}): UserRecord => {
  return {
    id: overrides.id ?? "user-1",
    email: overrides.email ?? "staff@example.com",
    isActive: overrides.isActive ?? true,
    mustChangePassword: overrides.mustChangePassword ?? false,
    roleAssignments:
      overrides.roleAssignments ?? [{ role: AppRole.STAFF, departmentId: null }],
  };
};

const createFakePrisma = (users: UserRecord[]) => {
  const store = new Map<string, UserRecord>(
    users.map((user) => [user.id, { ...user, roleAssignments: [...user.roleAssignments] }])
  );

  return {
    prisma: {
      user: {
        findFirst: async ({
          where,
        }: {
          where: {
            id?: string;
            isActive?: boolean;
          };
          include?: {
            roleAssignments?: boolean;
          };
        }) => {
          for (const user of store.values()) {
            if (where.id && user.id !== where.id) {
              continue;
            }

            if (where.isActive !== undefined && user.isActive !== where.isActive) {
              continue;
            }

            return {
              ...user,
              roleAssignments: user.roleAssignments.map((assignment) => ({ ...assignment })),
            };
          }

          return null;
        },
      },
    } as unknown,
  };
};

const expectRefreshError = async (
  operation: Promise<unknown>
): Promise<RefreshError> => {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof RefreshError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected refresh operation to fail");
};

const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[auth-refresh] ${name} failed: ${reason}`);
  }
};

const run = async (): Promise<void> => {
  await runTest("refresh returns new auth payload for active user", async () => {
    const user = createUser({ id: "refresh-user" });
    const fake = createFakePrisma([user]);
    const originalTokens = issueAuthTokens(
      {
        userId: user.id,
        role: AppRole.STAFF,
      },
      tokenConfig
    );

    const result = await refreshAuthTokens(
      fake.prisma as never,
      {
        refreshToken: originalTokens.refreshToken,
        stationId: " station-77 ",
      },
      tokenConfig
    );

    equal(result.user.id, user.id);
    equal(result.user.role, AppRole.STAFF);
    equal(result.auth.tokenType, "Bearer");
    ok(result.auth.accessToken.length > 10, "access token should be issued");
  });

  await runTest("refresh rejects access token in refreshToken field", async () => {
    const user = createUser({ id: "wrong-token-type-user" });
    const fake = createFakePrisma([user]);
    const originalTokens = issueAuthTokens(
      {
        userId: user.id,
        role: AppRole.STAFF,
      },
      tokenConfig
    );

    const error = await expectRefreshError(
      refreshAuthTokens(
        fake.prisma as never,
        {
          refreshToken: originalTokens.accessToken,
        },
        tokenConfig
      )
    );

    equal(error.code, "INVALID_TOKEN");
    equal(error.status, 401);
  });

  await runTest("refresh requires requestedRole when user has multiple assignments", async () => {
    const user = createUser({
      id: "multi-role-user",
      roleAssignments: [
        { role: AppRole.STAFF, departmentId: null },
        { role: AppRole.MANAGER, departmentId: "dept-1" },
      ],
    });
    const fake = createFakePrisma([user]);
    const originalTokens = issueAuthTokens(
      {
        userId: user.id,
        role: AppRole.STAFF,
      },
      tokenConfig
    );

    const error = await expectRefreshError(
      refreshAuthTokens(
        fake.prisma as never,
        {
          refreshToken: originalTokens.refreshToken,
        },
        tokenConfig
      )
    );

    equal(error.code, "ROLE_SELECTION_REQUIRED");
    equal(error.status, 409);
  });

  await runTest("logout skeleton validates refresh token", async () => {
    const tokens = issueAuthTokens(
      {
        userId: "logout-user",
        role: AppRole.STAFF,
      },
      tokenConfig
    );

    logoutWithRefreshTokenSkeleton(tokens.refreshToken, tokenConfig.jwtRefreshTokenSecret);

    const error = await expectRefreshError(
      Promise.resolve().then(() => {
        logoutWithRefreshTokenSkeleton("invalid.token", tokenConfig.jwtRefreshTokenSecret);
      })
    );

    equal(error.code, "INVALID_TOKEN");
    equal(error.status, 401);
  });
};

void run();
