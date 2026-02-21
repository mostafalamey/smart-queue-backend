import { AppRole, PrismaClient, RoleAssignment } from "@prisma/client";
import { issueAuthTokens, IssuedAuthTokens, TokenIssuerConfig } from "./tokens";
import {
  createArgon2idPasswordHash,
  verifyPasswordHash,
  verifyPasswordHashWithMetadata,
} from "./password";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let dummyPasswordHashPromise: Promise<string> | null = null;

const getDummyPasswordHash = (): Promise<string> => {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = createArgon2idPasswordHash("dummy-password");
  }

  return dummyPasswordHashPromise;
};

export interface LoginInput {
  email: string;
  password: string;
  stationId?: string;
  requestedRole?: AppRole;
}

export interface LoginResult {
  user: {
    id: string;
    email: string;
    role: AppRole;
    departmentId?: string;
    mustChangePassword: boolean;
  };
  auth: IssuedAuthTokens;
}

export type LoginErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "ACCOUNT_LOCKED"
  | "ROLE_SELECTION_REQUIRED";

export class LoginError extends Error {
  readonly status: number;
  readonly code: LoginErrorCode;

  constructor(status: number, code: LoginErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "LoginError";
  }
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const selectRoleAssignment = (
  assignments: RoleAssignment[],
  requestedRole: AppRole | undefined
): RoleAssignment | null => {
  if (assignments.length === 0) {
    return null;
  }

  if (requestedRole) {
    const matchingAssignments = assignments.filter(
      (assignment) => assignment.role === requestedRole
    );

    if (matchingAssignments.length === 0) {
      throw new LoginError(
        403,
        "FORBIDDEN",
        "Requested role is not assigned to this user"
      );
    }

    if (matchingAssignments.length > 1) {
      throw new LoginError(
        409,
        "ROLE_SELECTION_REQUIRED",
        "Multiple assignments found for requested role. Department-specific selection is required."
      );
    }

    return matchingAssignments[0];
  }

  if (assignments.length > 1) {
    throw new LoginError(
      409,
      "ROLE_SELECTION_REQUIRED",
      "Multiple role assignments found. requestedRole is required."
    );
  }

  return assignments[0];
};

const assertValidCredentialsInput = (input: LoginInput): void => {
  if (!input.email || input.email.trim().length === 0) {
    throw new LoginError(400, "INVALID_REQUEST", "email is required");
  }

  const normalizedEmail = normalizeEmail(input.email);
  if (!BASIC_EMAIL_PATTERN.test(normalizedEmail)) {
    throw new LoginError(400, "INVALID_REQUEST", "email format is invalid");
  }

  if (input.password == null || input.password.length === 0) {
    throw new LoginError(400, "INVALID_REQUEST", "password is required");
  }
};

const ensureNotLocked = (lockedUntil: Date | null): void => {
  if (!lockedUntil) {
    return;
  }

  if (lockedUntil.getTime() <= Date.now()) {
    return;
  }

  throw new LoginError(
    401,
    "ACCOUNT_LOCKED",
    `Account is temporarily locked due to too many failed sign-in attempts. Try again after ${lockedUntil.toISOString()}.`
  );
};

const invalidCredentials = (): LoginError => {
  return new LoginError(401, "INVALID_CREDENTIALS", "Invalid credentials");
};

const logLoginPersistenceFailure = (
  operation: "failed_attempt_increment" | "success_reset",
  userId: string,
  error: unknown
): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth/login] ${operation} persistence failed`, {
    userId,
    message,
  });
};

export const loginWithPassword = async (
  prismaClient: PrismaClient,
  input: LoginInput,
  tokenConfig: TokenIssuerConfig
): Promise<LoginResult> => {
  assertValidCredentialsInput(input);

  const email = normalizeEmail(input.email);
  const user = await prismaClient.$transaction(async (transactionClient) => {
    const candidateUser = await transactionClient.user.findFirst({
      where: {
        email,
        isActive: true,
      },
      include: {
        roleAssignments: true,
      },
    });

    if (!candidateUser) {
      const dummyPasswordHash = await getDummyPasswordHash();
      await verifyPasswordHash(input.password, dummyPasswordHash);
      throw invalidCredentials();
    }

    await transactionClient.$executeRaw`
      SELECT 1
      FROM "User"
      WHERE id = ${candidateUser.id}
      FOR UPDATE
    `;

    const lockedUser = await transactionClient.user.findUnique({
      where: {
        id: candidateUser.id,
      },
      include: {
        roleAssignments: true,
      },
    });

    if (!lockedUser || !lockedUser.isActive) {
      const dummyPasswordHash = await getDummyPasswordHash();
      await verifyPasswordHash(input.password, dummyPasswordHash);
      throw invalidCredentials();
    }

    ensureNotLocked(lockedUser.lockedUntil);

    const passwordVerification = await verifyPasswordHashWithMetadata(
      input.password,
      lockedUser.passwordHash
    );

    const rehashedPassword = passwordVerification.needsRehash
      ? await createArgon2idPasswordHash(input.password)
      : undefined;

    if (!passwordVerification.isValid) {
      const updatedFailedLoginAttempts = lockedUser.failedLoginAttempts + 1;
      const shouldLock = updatedFailedLoginAttempts >= MAX_FAILED_ATTEMPTS;

      await transactionClient.user
        .update({
          where: {
            id: lockedUser.id,
          },
          data: {
            failedLoginAttempts: updatedFailedLoginAttempts,
            lockedUntil: shouldLock
              ? new Date(Date.now() + LOCKOUT_DURATION_MS)
              : null,
          },
        })
        .catch((error: unknown) => {
          logLoginPersistenceFailure(
            "failed_attempt_increment",
            lockedUser.id,
            error
          );
        });

      throw invalidCredentials();
    }

    const roleAssignment = selectRoleAssignment(
      lockedUser.roleAssignments,
      input.requestedRole
    );
    if (!roleAssignment) {
      throw new LoginError(403, "FORBIDDEN", "No role assignment found for user");
    }

    if (roleAssignment.role === AppRole.MANAGER && !roleAssignment.departmentId) {
      throw new LoginError(
        403,
        "FORBIDDEN",
        "Manager role assignment must be scoped to one department"
      );
    }

    await transactionClient.user
      .update({
        where: {
          id: lockedUser.id,
        },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          passwordHash: rehashedPassword,
        },
      })
      .catch((error: unknown) => {
        logLoginPersistenceFailure("success_reset", lockedUser.id, error);
      });

    return {
      id: lockedUser.id,
      email: lockedUser.email,
      role: roleAssignment.role,
      departmentId: roleAssignment.departmentId ?? undefined,
      mustChangePassword: lockedUser.mustChangePassword,
    };
  });

  const stationId = input.stationId?.trim() || undefined;
  const auth = issueAuthTokens(
    {
      userId: user.id,
      role: user.role,
      stationId,
    },
    tokenConfig
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId,
      mustChangePassword: user.mustChangePassword,
    },
    auth,
  };
};
