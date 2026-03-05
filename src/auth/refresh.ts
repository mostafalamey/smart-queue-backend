import { AppRole, PrismaClient, RoleAssignment } from "@prisma/client";
import {
  issueAuthTokens,
  IssuedAuthTokens,
  TokenIssuerConfig,
} from "./tokens";
import { AuthTokenError } from "./types";
import { verifyRefreshToken } from "./jwt";

export interface RefreshInput {
  refreshToken: string;
  requestedRole?: AppRole;
  stationId?: string;
}

export interface RefreshResult {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: AppRole;
    departmentId?: string;
    mustChangePassword: boolean;
  };
  auth: IssuedAuthTokens;
}

export type RefreshErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_TOKEN"
  | "FORBIDDEN"
  | "ROLE_SELECTION_REQUIRED";

export class RefreshError extends Error {
  readonly status: number;
  readonly code: RefreshErrorCode;

  constructor(status: number, code: RefreshErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "RefreshError";
  }
}

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
      throw new RefreshError(
        403,
        "FORBIDDEN",
        "Requested role is not assigned to this user"
      );
    }

    if (matchingAssignments.length > 1) {
      throw new RefreshError(
        409,
        "ROLE_SELECTION_REQUIRED",
        "Multiple assignments found for requested role. Department-specific selection is required."
      );
    }

    return matchingAssignments[0];
  }

  if (assignments.length > 1) {
    throw new RefreshError(
      409,
      "ROLE_SELECTION_REQUIRED",
      "Multiple role assignments found. requestedRole is required."
    );
  }

  return assignments[0];
};

const parseAndVerifyRefreshToken = (
  token: string,
  refreshTokenSecret: string
): string => {
  if (!token || token.trim().length === 0) {
    throw new RefreshError(400, "INVALID_REQUEST", "refreshToken is required");
  }

  try {
    const claims = verifyRefreshToken(token, refreshTokenSecret);
    return claims.sub;
  } catch (error: unknown) {
    if (error instanceof AuthTokenError) {
      throw new RefreshError(401, "INVALID_TOKEN", error.message);
    }

    throw error;
  }
};

export const refreshAuthTokens = async (
  prismaClient: PrismaClient,
  input: RefreshInput,
  tokenConfig: TokenIssuerConfig
): Promise<RefreshResult> => {
  const userId = parseAndVerifyRefreshToken(
    input.refreshToken,
    tokenConfig.jwtRefreshTokenSecret
  );

  const user = await prismaClient.user.findFirst({
    where: {
      id: userId,
      isActive: true,
    },
    include: {
      roleAssignments: true,
    },
  });

  if (!user) {
    throw new RefreshError(
      401,
      "INVALID_TOKEN",
      "Refresh token subject is not an active user"
    );
  }

  const roleAssignment = selectRoleAssignment(
    user.roleAssignments,
    input.requestedRole
  );

  if (!roleAssignment) {
    throw new RefreshError(403, "FORBIDDEN", "No role assignment found for user");
  }

  if (roleAssignment.role === AppRole.MANAGER && !roleAssignment.departmentId) {
    throw new RefreshError(
      403,
      "FORBIDDEN",
      "Manager role assignment must be scoped to one department"
    );
  }

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
      name: user.name,
      role: roleAssignment.role,
      departmentId: roleAssignment.departmentId ?? undefined,
      mustChangePassword: user.mustChangePassword,
    },
    auth,
  };
};

export const logoutWithRefreshTokenSkeleton = (
  refreshToken: string,
  refreshTokenSecret: string
): void => {
  parseAndVerifyRefreshToken(refreshToken, refreshTokenSecret);
};
