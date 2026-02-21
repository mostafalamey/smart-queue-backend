import { createHmac, timingSafeEqual } from "node:crypto";
import { AppRole } from "@prisma/client";
import { AccessTokenClaims, AuthTokenError, RefreshTokenClaims } from "./types";

interface JwtHeader {
  alg?: string;
  typ?: string;
}

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new AuthTokenError("Invalid token encoding");
  }
};

const parseJson = <T>(raw: string, errorMessage: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AuthTokenError(errorMessage);
  }
};

const toBuffer = (value: string): Buffer => {
  return Buffer.from(value, "utf8");
};

const assertRole = (value: unknown): AppRole => {
  if (typeof value !== "string") {
    throw new AuthTokenError("Token role claim must be a string");
  }

  const allowedRoles = Object.values(AppRole) as string[];
  if (!allowedRoles.includes(value)) {
    throw new AuthTokenError("Token role claim is invalid");
  }

  return value as AppRole;
};

const validateClaims = (payload: Record<string, unknown>): AccessTokenClaims => {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw new AuthTokenError("Token subject claim is invalid");
  }

  const role = assertRole(payload.role);

  const stationIdClaim = payload.stationId;
  if (
    stationIdClaim !== undefined &&
    (typeof stationIdClaim !== "string" || stationIdClaim.trim().length === 0)
  ) {
    throw new AuthTokenError("Token stationId claim is invalid");
  }

  const expClaim = payload.exp;
  if (expClaim !== undefined && typeof expClaim !== "number") {
    throw new AuthTokenError("Token exp claim is invalid");
  }

  const iatClaim = payload.iat;
  if (iatClaim !== undefined && typeof iatClaim !== "number") {
    throw new AuthTokenError("Token iat claim is invalid");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof expClaim === "number" && expClaim <= nowSeconds) {
    throw new AuthTokenError("Token has expired");
  }

  return {
    sub,
    role,
    stationId: typeof stationIdClaim === "string" ? stationIdClaim : undefined,
    exp: typeof expClaim === "number" ? expClaim : undefined,
    iat: typeof iatClaim === "number" ? iatClaim : undefined,
  };
};

const validateRefreshClaims = (
  payload: Record<string, unknown>
): RefreshTokenClaims => {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw new AuthTokenError("Token subject claim is invalid");
  }

  const typ = payload.typ;
  if (typ !== "refresh") {
    throw new AuthTokenError("Token type must be refresh");
  }

  const expClaim = payload.exp;
  if (expClaim !== undefined && typeof expClaim !== "number") {
    throw new AuthTokenError("Token exp claim is invalid");
  }

  const iatClaim = payload.iat;
  if (iatClaim !== undefined && typeof iatClaim !== "number") {
    throw new AuthTokenError("Token iat claim is invalid");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof expClaim === "number" && expClaim <= nowSeconds) {
    throw new AuthTokenError("Token has expired");
  }

  return {
    sub,
    typ: "refresh",
    exp: typeof expClaim === "number" ? expClaim : undefined,
    iat: typeof iatClaim === "number" ? iatClaim : undefined,
  };
};

const verifySignedJwtPayload = (
  token: string,
  secret: string
): Record<string, unknown> => {
  if (!token || token.trim().length === 0) {
    throw new AuthTokenError("Token is required");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthTokenError("Token format is invalid");
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  const header = parseJson<JwtHeader>(
    decodeBase64Url(headerPart),
    "Token header is invalid"
  );

  if (header.alg !== "HS256") {
    throw new AuthTokenError("Unsupported token algorithm");
  }

  const signedPayload = `${headerPart}.${payloadPart}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const actualSignatureBuffer = toBuffer(signaturePart);
  const expectedSignatureBuffer = toBuffer(expectedSignature);

  if (actualSignatureBuffer.length !== expectedSignatureBuffer.length) {
    throw new AuthTokenError("Token signature is invalid");
  }

  if (!timingSafeEqual(actualSignatureBuffer, expectedSignatureBuffer)) {
    throw new AuthTokenError("Token signature is invalid");
  }

  return parseJson<Record<string, unknown>>(
    decodeBase64Url(payloadPart),
    "Token payload is invalid"
  );
};

export const verifyAccessToken = (
  token: string,
  secret: string
): AccessTokenClaims => {
  const payload = verifySignedJwtPayload(token, secret);
  return validateClaims(payload);
};

export const verifyRefreshToken = (
  token: string,
  secret: string
): RefreshTokenClaims => {
  const payload = verifySignedJwtPayload(token, secret);
  return validateRefreshClaims(payload);
};
