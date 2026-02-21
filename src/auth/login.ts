import { AppRole, PrismaClient, RoleAssignment } from "@prisma/client";
import { issueAuthTokens, IssuedAuthTokens, TokenIssuerConfig } from "./tokens";
import { verifyPasswordHash } from "./password";

const ROLE_PRIORITY: AppRole[] = [
  AppRole.ADMIN,
  AppRole.IT,
  AppRole.MANAGER,
  AppRole.STAFF,
];

export interface LoginInput {
  email: string;
  password: string;
  stationId?: string;
  deviceId?: string;
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

export class LoginError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "LoginError";
  }
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const pickPrimaryRole = (assignments: RoleAssignment[]): RoleAssignment | null => {
  for (const role of ROLE_PRIORITY) {
    const match = assignments.find((assignment) => assignment.role === role);
    if (match) {
      return match;
    }
  }

  return null;
};

const assertValidCredentialsInput = (input: LoginInput): void => {
  if (!input.email || input.email.trim().length === 0) {
    throw new LoginError(400, "INVALID_REQUEST", "email is required");
  }

  if (!input.password || input.password.trim().length === 0) {
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

  throw new LoginError(401, "INVALID_CREDENTIALS", "Invalid credentials");
};

const invalidCredentials = (): LoginError => {
  return new LoginError(401, "INVALID_CREDENTIALS", "Invalid credentials");
};

export const loginWithPassword = async (
  prismaClient: PrismaClient,
  input: LoginInput,
  tokenConfig: TokenIssuerConfig
): Promise<LoginResult> => {
  assertValidCredentialsInput(input);

  const email = normalizeEmail(input.email);
  const user = await prismaClient.user.findFirst({
    where: {
      email,
      isActive: true,
    },
    include: {
      roleAssignments: true,
    },
  });

  if (!user) {
    throw invalidCredentials();
  }

  ensureNotLocked(user.lockedUntil);

  if (!verifyPasswordHash(input.password, user.passwordHash)) {
    await prismaClient.user
      .update({
        where: {
          id: user.id,
        },
        data: {
          failedLoginAttempts: {
            increment: 1,
          },
        },
      })
      .catch(() => undefined);

    throw invalidCredentials();
  }

  const roleAssignment = pickPrimaryRole(user.roleAssignments);
  if (!roleAssignment) {
    throw new LoginError(403, "FORBIDDEN", "No role assignment found for user");
  }

  await prismaClient.user
    .update({
      where: {
        id: user.id,
      },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    })
    .catch(() => undefined);

  const stationId = input.stationId?.trim() || undefined;
  const auth = issueAuthTokens(
    {
      userId: user.id,
      role: roleAssignment.role,
      stationId,
    },
    tokenConfig
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      role: roleAssignment.role,
      departmentId: roleAssignment.departmentId ?? undefined,
      mustChangePassword: user.mustChangePassword,
    },
    auth,
  };
};
