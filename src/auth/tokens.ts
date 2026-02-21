import { AppRole } from "@prisma/client";
import { createHmac } from "node:crypto";

export interface TokenIssuerConfig {
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
}

export interface TokenIssuePayload {
  userId: string;
  role: AppRole;
  stationId?: string;
}

export interface IssuedAuthTokens {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;
const REFRESH_TOKEN_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

const toBase64Url = (value: string): string => {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const signJwt = (
  payload: Record<string, unknown>,
  secret: string
): string => {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
};

export const issueAuthTokens = (
  payload: TokenIssuePayload,
  config: TokenIssuerConfig
): IssuedAuthTokens => {
  const issuedAt = Math.floor(Date.now() / 1000);

  const accessToken = signJwt(
    {
      sub: payload.userId,
      role: payload.role,
      stationId: payload.stationId,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    },
    config.jwtAccessTokenSecret
  );

  const refreshToken = signJwt(
    {
      sub: payload.userId,
      role: payload.role,
      typ: "refresh",
      iat: issuedAt,
      exp: issuedAt + REFRESH_TOKEN_EXPIRES_IN_SECONDS,
    },
    config.jwtRefreshTokenSecret
  );

  return {
    tokenType: "Bearer",
    accessToken,
    refreshToken,
    accessTokenExpiresInSeconds: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    refreshTokenExpiresInSeconds: REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  };
};
