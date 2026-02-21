import { AppRole } from "@prisma/client";

export interface AuthenticatedPrincipal {
  userId: string;
  role: AppRole;
  stationId?: string;
}

export interface AccessTokenClaims {
  sub: string;
  role: AppRole;
  stationId?: string;
  exp?: number;
  iat?: number;
}

export interface RefreshTokenClaims {
  sub: string;
  typ: "refresh";
  exp?: number;
  iat?: number;
}

export class AuthTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTokenError";
  }
}
