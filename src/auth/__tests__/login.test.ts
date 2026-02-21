import { AppRole } from "@prisma/client";
import { LoginError, loginWithPassword } from "../login";
import { createScryptPasswordHash } from "../password";
import { verifyAccessToken } from "../jwt";

interface RoleAssignmentRecord {
  role: AppRole;
  departmentId: string | null;
}

interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  roleAssignments: RoleAssignmentRecord[];
}

interface FakePrismaOptions {
  throwOnFindFirst?: boolean;
  throwOnFindUnique?: boolean;
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
    passwordHash: overrides.passwordHash ?? createScryptPasswordHash("ValidPass1!"),
    isActive: overrides.isActive ?? true,
    mustChangePassword: overrides.mustChangePassword ?? false,
    failedLoginAttempts: overrides.failedLoginAttempts ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
    roleAssignments:
      overrides.roleAssignments ?? [{ role: AppRole.STAFF, departmentId: null }],
  };
};

const createLock = () => {
  let chain = Promise.resolve();

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = chain.then(operation);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
};

const createFakePrisma = (users: UserRecord[], options: FakePrismaOptions = {}) => {
  const lock = createLock();
  const store = new Map<string, UserRecord>(users.map((user) => [user.id, { ...user, roleAssignments: [...user.roleAssignments] }]));

  const findByEmail = (email: string): UserRecord | null => {
    for (const user of store.values()) {
      if (user.email === email && user.isActive) {
        return user;
      }
    }

    return null;
  };

  const cloneUser = (user: UserRecord): UserRecord => {
    return {
      ...user,
      lockedUntil: user.lockedUntil ? new Date(user.lockedUntil.getTime()) : null,
      roleAssignments: user.roleAssignments.map((assignment) => ({ ...assignment })),
    };
  };

  const txClient = {
    user: {
      findFirst: async ({ where }: { where: { email: string; isActive: boolean } }) => {
        if (options.throwOnFindFirst) {
          throw new Error("db-findFirst-error");
        }

        if (!where.isActive) {
          return null;
        }

        const user = findByEmail(where.email);
        return user ? cloneUser(user) : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (options.throwOnFindUnique) {
          throw new Error("db-findUnique-error");
        }

        const user = store.get(where.id);
        return user ? cloneUser(user) : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          failedLoginAttempts?: number;
          lockedUntil?: Date | null;
          passwordHash?: string | undefined;
        };
      }) => {
        const user = store.get(where.id);
        if (!user) {
          throw new Error("user-not-found");
        }

        if (data.failedLoginAttempts !== undefined) {
          user.failedLoginAttempts = data.failedLoginAttempts;
        }

        if (data.lockedUntil !== undefined) {
          user.lockedUntil = data.lockedUntil;
        }

        if (data.passwordHash !== undefined) {
          user.passwordHash = data.passwordHash;
        }

        return cloneUser(user);
      },
    },
    $executeRaw: async () => 1,
  };

  return {
    prisma: {
      $transaction: async <T>(operation: (client: typeof txClient) => Promise<T>) => {
        return lock(() => operation(txClient));
      },
    } as unknown,
    getUserById: (userId: string): UserRecord | undefined => {
      const user = store.get(userId);
      return user ? cloneUser(user) : undefined;
    },
  };
};

const expectLoginError = async (
  operation: Promise<unknown>
): Promise<LoginError> => {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof LoginError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected login to fail");
};

const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[auth-login] ${name} failed: ${reason}`);
  }
};

const run = async (): Promise<void> => {
  await runTest("successful login returns tokens and resets failed attempts", async () => {
    const user = createUser({
      id: "success-user",
      failedLoginAttempts: 3,
      lockedUntil: new Date(Date.now() - 10_000),
      passwordHash: createScryptPasswordHash("GoodPass1!"),
    });
    const fake = createFakePrisma([user]);

    const result = await loginWithPassword(
      fake.prisma as never,
      {
        email: user.email,
        password: "GoodPass1!",
      },
      tokenConfig
    );

    equal(result.user.id, user.id);
    equal(result.user.role, AppRole.STAFF);
    equal(result.auth.tokenType, "Bearer");

    const persisted = fake.getUserById(user.id);
    ok(!!persisted, "persisted user should exist");
    equal(persisted?.failedLoginAttempts, 0);
    equal(persisted?.lockedUntil, null);
  });

  await runTest("invalid credentials increment failed attempts", async () => {
    const user = createUser({ id: "invalid-pass-user", passwordHash: createScryptPasswordHash("RightPass1!") });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "WrongPass1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "INVALID_CREDENTIALS");

    const persisted = fake.getUserById(user.id);
    equal(persisted?.failedLoginAttempts, 1);
    equal(persisted?.lockedUntil, null);
  });

  await runTest("locks account after threshold of failed attempts", async () => {
    const user = createUser({
      id: "lock-user",
      failedLoginAttempts: 4,
      passwordHash: createScryptPasswordHash("Correct1!"),
    });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "Wrong1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "INVALID_CREDENTIALS");

    const persisted = fake.getUserById(user.id);
    equal(persisted?.failedLoginAttempts, 5);
    ok(!!persisted?.lockedUntil, "lockedUntil should be set at threshold");
  });

  await runTest("locked account returns ACCOUNT_LOCKED", async () => {
    const lockUntil = new Date(Date.now() + 60_000);
    const user = createUser({
      id: "locked-user",
      lockedUntil: lockUntil,
      passwordHash: createScryptPasswordHash("Valid1!"),
    });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "Valid1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "ACCOUNT_LOCKED");
    ok(error.message.includes(lockUntil.toISOString()), "lock message should include unlock timestamp");
  });

  await runTest("role selection requires requestedRole for multiple assignments", async () => {
    const user = createUser({
      id: "multi-role-user",
      roleAssignments: [
        { role: AppRole.MANAGER, departmentId: "dept-1" },
        { role: AppRole.STAFF, departmentId: null },
      ],
      passwordHash: createScryptPasswordHash("RolePass1!"),
    });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "RolePass1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "ROLE_SELECTION_REQUIRED");
  });

  await runTest("requested role selects scoped assignment", async () => {
    const user = createUser({
      id: "requested-role-user",
      roleAssignments: [
        { role: AppRole.MANAGER, departmentId: "dept-77" },
        { role: AppRole.STAFF, departmentId: null },
      ],
      passwordHash: createScryptPasswordHash("RolePick1!"),
    });
    const fake = createFakePrisma([user]);

    const result = await loginWithPassword(
      fake.prisma as never,
      {
        email: user.email,
        password: "RolePick1!",
        requestedRole: AppRole.MANAGER,
      },
      tokenConfig
    );

    equal(result.user.role, AppRole.MANAGER);
    equal(result.user.departmentId, "dept-77");
  });

  await runTest("stationId is trimmed and embedded in access token claims", async () => {
    const user = createUser({ id: "station-user", passwordHash: createScryptPasswordHash("Station1!") });
    const fake = createFakePrisma([user]);

    const result = await loginWithPassword(
      fake.prisma as never,
      {
        email: user.email,
        password: "Station1!",
        stationId: "  station-42  ",
      },
      tokenConfig
    );

    const claims = verifyAccessToken(result.auth.accessToken, tokenConfig.jwtAccessTokenSecret);
    equal(claims.stationId, "station-42");
  });

  await runTest("user not found returns invalid credentials", async () => {
    const fake = createFakePrisma([]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: "missing@example.com",
          password: "Missing1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "INVALID_CREDENTIALS");
  });

  await runTest("inactive users are rejected as invalid credentials", async () => {
    const user = createUser({ id: "inactive-user", isActive: false, passwordHash: createScryptPasswordHash("Inactive1!") });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "Inactive1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "INVALID_CREDENTIALS");
  });

  await runTest("missing role assignments return FORBIDDEN", async () => {
    const user = createUser({ id: "no-role-user", roleAssignments: [], passwordHash: createScryptPasswordHash("NoRole1!") });
    const fake = createFakePrisma([user]);

    const error = await expectLoginError(
      loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "NoRole1!",
        },
        tokenConfig
      )
    );

    equal(error.code, "FORBIDDEN");
  });

  await runTest("database errors are propagated", async () => {
    const user = createUser({ id: "db-error-user", passwordHash: createScryptPasswordHash("DbErr1!") });
    const fake = createFakePrisma([user], { throwOnFindFirst: true });

    try {
      await loginWithPassword(
        fake.prisma as never,
        {
          email: user.email,
          password: "DbErr1!",
        },
        tokenConfig
      );
      throw new Error("Expected database error");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      equal(message, "db-findFirst-error");
    }
  });

  await runTest("concurrent failed logins respect lock and avoid double-increment", async () => {
    const user = createUser({
      id: "concurrent-user",
      failedLoginAttempts: 4,
      passwordHash: createScryptPasswordHash("Concurrent1!"),
    });
    const fake = createFakePrisma([user]);

    const attempts = await Promise.allSettled([
      loginWithPassword(
        fake.prisma as never,
        { email: user.email, password: "Wrong1!" },
        tokenConfig
      ),
      loginWithPassword(
        fake.prisma as never,
        { email: user.email, password: "Wrong1!" },
        tokenConfig
      ),
    ]);

    const codes = attempts
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => {
        const reason = result.reason;
        if (reason instanceof LoginError) {
          return reason.code;
        }

        return "UNKNOWN";
      });

    ok(codes.includes("INVALID_CREDENTIALS"), "one request should fail invalid credentials");
    ok(codes.includes("ACCOUNT_LOCKED"), "one request should fail due to account lock");

    const persisted = fake.getUserById(user.id);
    equal(persisted?.failedLoginAttempts, 5);
    ok(!!persisted?.lockedUntil, "user should remain locked after concurrent failures");
  });
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
