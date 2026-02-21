import { AppRole } from "@prisma/client";
import { createHmac } from "node:crypto";
import { verifyAccessToken } from "../jwt";
import { issueAuthTokens } from "../tokens";
import { AuthTokenError } from "../types";

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
    throw new Error(`[auth-tokens] ${name} failed: ${reason}`);
  }
};

const decodeBase64UrlJson = (segment: string): Record<string, unknown> => {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
};

const computeSignature = (headerPart: string, payloadPart: string, secret: string): string => {
  const signingInput = `${headerPart}.${payloadPart}`;
  return createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const splitJwt = (token: string): [string, string, string] => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Token must contain 3 JWT segments");
  }

  return [parts[0], parts[1], parts[2]];
};

const config = {
  jwtAccessTokenSecret: "access-secret-for-tests",
  jwtRefreshTokenSecret: "refresh-secret-for-tests",
};

runTest("issues JWT tokens with expected structure and metadata", () => {
  const issued = issueAuthTokens(
    {
      userId: "user-1",
      role: AppRole.STAFF,
      stationId: "station-a",
    },
    config
  );

  equal(issued.tokenType, "Bearer");
  equal(issued.accessTokenExpiresInSeconds, 15 * 60);
  equal(issued.refreshTokenExpiresInSeconds, 7 * 24 * 60 * 60);

  const accessParts = splitJwt(issued.accessToken);
  const refreshParts = splitJwt(issued.refreshToken);

  ok(/^[A-Za-z0-9_-]+$/.test(accessParts[0]), "access header must be base64url");
  ok(/^[A-Za-z0-9_-]+$/.test(accessParts[1]), "access payload must be base64url");
  ok(/^[A-Za-z0-9_-]+$/.test(accessParts[2]), "access signature must be base64url");

  ok(/^[A-Za-z0-9_-]+$/.test(refreshParts[0]), "refresh header must be base64url");
  ok(/^[A-Za-z0-9_-]+$/.test(refreshParts[1]), "refresh payload must be base64url");
  ok(/^[A-Za-z0-9_-]+$/.test(refreshParts[2]), "refresh signature must be base64url");
});

runTest("signs access token payload and verifies with verifyAccessToken", () => {
  const issued = issueAuthTokens(
    {
      userId: "user-2",
      role: AppRole.MANAGER,
      stationId: "station-b",
    },
    config
  );

  const [headerPart, payloadPart, signaturePart] = splitJwt(issued.accessToken);
  const header = decodeBase64UrlJson(headerPart);

  equal(header.alg, "HS256");
  equal(header.typ, "JWT");

  const payload = decodeBase64UrlJson(payloadPart);
  equal(payload.sub, "user-2");
  equal(payload.role, AppRole.MANAGER);
  equal(payload.stationId, "station-b");

  const expectedSignature = computeSignature(
    headerPart,
    payloadPart,
    config.jwtAccessTokenSecret
  );
  equal(signaturePart, expectedSignature, "access token signature must match HMAC");

  const verifiedClaims = verifyAccessToken(issued.accessToken, config.jwtAccessTokenSecret);
  equal(verifiedClaims.sub, "user-2");
  equal(verifiedClaims.role, AppRole.MANAGER);
  equal(verifiedClaims.stationId, "station-b");
  ok(typeof verifiedClaims.iat === "number", "verified iat must be present");
  ok(typeof verifiedClaims.exp === "number", "verified exp must be present");
});

runTest("issues refresh token with minimal claims and valid signature", () => {
  const issued = issueAuthTokens(
    {
      userId: "user-3",
      role: AppRole.ADMIN,
    },
    config
  );

  const [headerPart, payloadPart, signaturePart] = splitJwt(issued.refreshToken);
  const payload = decodeBase64UrlJson(payloadPart);

  equal(payload.sub, "user-3");
  equal(payload.typ, "refresh");
  ok(payload.role === undefined, "refresh token must not carry role claim");

  const expectedSignature = computeSignature(
    headerPart,
    payloadPart,
    config.jwtRefreshTokenSecret
  );
  equal(signaturePart, expectedSignature, "refresh token signature must match HMAC");

  try {
    verifyAccessToken(issued.refreshToken, config.jwtRefreshTokenSecret);
    throw new Error("Expected refresh token to fail access-token verification");
  } catch (error: unknown) {
    if (!(error instanceof AuthTokenError)) {
      throw error;
    }

    equal(error.message, "Token role claim must be a string");
  }
});

runTest("uses custom expiration durations when provided in config", () => {
  const issued = issueAuthTokens(
    {
      userId: "user-ttl",
      role: AppRole.STAFF,
    },
    {
      ...config,
      accessTokenExpiresInSeconds: 60,
      refreshTokenExpiresInSeconds: 120,
    }
  );

  equal(issued.accessTokenExpiresInSeconds, 60);
  equal(issued.refreshTokenExpiresInSeconds, 120);

  const [, accessPayloadPart] = splitJwt(issued.accessToken);
  const accessPayload = decodeBase64UrlJson(accessPayloadPart);
  equal(
    Number(accessPayload.exp) - Number(accessPayload.iat),
    60,
    "access exp-iat should match configured duration"
  );

  const [, refreshPayloadPart] = splitJwt(issued.refreshToken);
  const refreshPayload = decodeBase64UrlJson(refreshPayloadPart);
  equal(
    Number(refreshPayload.exp) - Number(refreshPayload.iat),
    120,
    "refresh exp-iat should match configured duration"
  );
});
