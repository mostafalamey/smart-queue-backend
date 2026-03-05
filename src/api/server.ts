/// <reference path="../types/node-shim.d.ts" />
/// <reference path="../types/crypto-shim.d.ts" />

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppRole, PrismaClient, TemplateChannel } from "@prisma/client";
import { createTellerApiHandlers } from "./teller";
import { failure, HttpResponse } from "./http";
import {
  createQueueEngineService,
  QueueEngineError,
  QueueActor,
  QueueTicket,
} from "../queue-engine";
import {
  AuthenticatedPrincipal,
  AuthTokenError,
  LoginError,
  RefreshError,
  createArgon2idPasswordHash,
  loginWithPassword,
  logoutWithRefreshTokenSkeleton,
  refreshAuthTokens,
  verifyAccessToken,
  verifyPasswordHashWithMetadata,
} from "../auth";
import {
  NoopQueueRealtimeBroadcaster,
  QueueRealtimeBroadcaster,
} from "../realtime";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface ParsedCallNextPayload {
  serviceId: string;
}

interface ParsedTicketActionPayload {
  ticketId: string;
}

interface ParsedTransferPayload extends ParsedTicketActionPayload {
  destination: {
    departmentId: string;
    serviceId: string;
    ticketDate: Date;
  };
  reasonId: string;
}

interface ParsedChangePriorityPayload extends ParsedTicketActionPayload {
  priorityCategoryId: string;
  priorityWeight: number;
}

interface ParsedAdminTransferReasonPayload {
  nameEn: string;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
}

interface ParsedAdminTransferReasonPatchPayload {
  nameEn?: string;
  nameAr?: string;
  sortOrder?: number;
  isActive?: boolean;
}

interface ParsedLoginPayload {
  email: string;
  password: string;
  stationId?: string;
  requestedRole?: AppRole;
}

interface ParsedChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
  name?: string;
}

interface ParsedRefreshPayload {
  refreshToken: string;
  stationId?: string;
  requestedRole?: AppRole;
}

interface ParsedLogoutPayload {
  refreshToken: string;
}

interface ParsedAdminConfigTemplatePayload {
  templateKey: string;
  language: string;
  content: string;
}

interface ParsedAdminConfigMappingPayload {
  stationId: string;
  deviceId: string;
}

interface ParsedAdminConfigRetentionPayload {
  retentionDays: number;
}

interface ParsedAdminConfigResetPayload {
  serviceId: string;
}

interface ParsedKioskIssueTicketPayload {
  departmentId: string;
  serviceId: string;
  phoneNumber: string;
}

interface AppRequestContext {
  requestId: string;
  principal?: AuthenticatedPrincipal;
}

interface PrincipalAccessScope {
  principal: AuthenticatedPrincipal;
  hospitalId: string;
  managerDepartmentId?: string;
}

interface RealtimeEmitInput {
  operation: string;
  context: AppRequestContext;
  actor: QueueActor;
  result: HttpResponse;
  fallbackServiceId?: string;
}

interface RouteGuardPolicy {
  allowedRoles: ReadonlySet<AppRole>;
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

class TooManyRequestsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooManyRequestsError";
  }
}

const REQUEST_ID_HEADER = "x-request-id";

const createRequestId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random}`;
};

const getRequestId = (request: IncomingMessage): string => {
  const providedRequestId = getHeader(request, REQUEST_ID_HEADER);
  if (providedRequestId && providedRequestId.trim().length > 0) {
    return providedRequestId.trim();
  }

  return createRequestId();
};

const createRequestContext = (request: IncomingMessage): AppRequestContext => {
  return {
    requestId: getRequestId(request),
  };
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
};

const getChunkSize = (chunk: string | Uint8Array): number => {
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk).length;
  }

  return chunk.byteLength;
};

const readJsonBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: string[] = [];
  let totalBytes = 0;

  const abortRequest = (): void => {
    const requestWithDestroy = request as IncomingMessage & {
      destroy?: (error?: Error) => void;
    };

    if (typeof requestWithDestroy.destroy === "function") {
      requestWithDestroy.destroy();
    }
  };

  for await (const chunk of request) {
    totalBytes += getChunkSize(chunk);

    if (totalBytes > MAX_JSON_BODY_BYTES) {
      abortRequest();
      throw new PayloadTooLargeError(
        `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`
      );
    }

    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  }

  const raw = chunks.join("").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);

  if (!record) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  return record;
};

const invalidRequest = (response: ServerResponse, message: string): void => {
  json(response, 400, {
    code: "INVALID_REQUEST",
    message,
  });
};

const payloadTooLarge = (response: ServerResponse, message: string): void => {
  json(response, 413, {
    code: "PAYLOAD_TOO_LARGE",
    message,
  });
};

const internalServerError = (response: ServerResponse): void => {
  json(response, 500, {
    code: "INTERNAL_ERROR",
    message: "Unexpected server error",
  });
};

const unauthorized = (response: ServerResponse, message: string): void => {
  json(response, 401, {
    code: "UNAUTHORIZED",
    message,
  });
};

const forbidden = (response: ServerResponse, message: string): void => {
  json(response, 403, {
    code: "FORBIDDEN",
    message,
  });
};

const notFound = (response: ServerResponse, message: string): void => {
  json(response, 404, {
    code: "NOT_FOUND",
    message,
  });
};

const tooManyRequests = (response: ServerResponse, message: string): void => {
  json(response, 429, {
    code: "TOO_MANY_REQUESTS",
    message,
  });
};

const getHeader = (request: IncomingMessage, name: string): string | undefined => {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
};

const LOGIN_IP_WINDOW_MS = 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 20;
const LOGIN_EMAIL_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_EMAIL_MAX_ATTEMPTS = 10;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const loginRateLimitByIp = new Map<string, RateLimitBucket>();
const loginRateLimitByEmail = new Map<string, RateLimitBucket>();

const consumeRateLimit = (
  store: Map<string, RateLimitBucket>,
  key: string,
  maxAttempts: number,
  windowMs: number,
  errorMessage: string
): void => {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    store.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return;
  }

  const nextCount = existing.count + 1;
  store.set(key, {
    count: nextCount,
    resetAt: existing.resetAt,
  });

  if (nextCount > maxAttempts) {
    throw new TooManyRequestsError(errorMessage);
  }
};

const getRequestIpAddress = (request: IncomingMessage): string => {
  const forwardedFor = getHeader(request, "x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor
      .split(",")
      .map((item) => item.trim())
      .find((item) => item.length > 0);

    if (firstIp) {
      return firstIp;
    }
  }

  return "unknown";
};

const applyLoginRateLimit = (
  request: IncomingMessage,
  email: string
): void => {
  const ipAddress = getRequestIpAddress(request);
  consumeRateLimit(
    loginRateLimitByIp,
    ipAddress,
    LOGIN_IP_MAX_ATTEMPTS,
    LOGIN_IP_WINDOW_MS,
    "Too many login attempts from this network. Please try again shortly."
  );

  consumeRateLimit(
    loginRateLimitByEmail,
    email.trim().toLowerCase(),
    LOGIN_EMAIL_MAX_ATTEMPTS,
    LOGIN_EMAIL_WINDOW_MS,
    "Too many login attempts for this account. Please try again later."
  );
};

const parseRole = (rawRole: string | undefined): AppRole | null => {
  if (!rawRole) {
    return null;
  }

  const allowed = Object.values(AppRole) as string[];
  if (!allowed.includes(rawRole)) {
    return null;
  }

  return rawRole as AppRole;
};

const TELLER_ROUTE_ALLOWED_ROLES = new Set<AppRole>([
  AppRole.ADMIN,
  AppRole.IT,
  AppRole.MANAGER,
  AppRole.STAFF,
]);

const ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES = new Set<AppRole>([
  AppRole.ADMIN,
  AppRole.IT,
]);

const ADMIN_CONFIG_RESETS_ALLOWED_ROLES = new Set<AppRole>([
  AppRole.ADMIN,
  AppRole.MANAGER,
]);

const ADMIN_QUEUE_ALLOWED_ROLES = new Set<AppRole>([
  AppRole.ADMIN,
  AppRole.MANAGER,
]);

const getAuthenticatedPrincipal = (
  request: IncomingMessage,
  jwtAccessTokenSecret: string
): AuthenticatedPrincipal => {
  const authorizationHeader = getHeader(request, "authorization");
  if (!authorizationHeader) {
    throw new UnauthorizedError("Missing Authorization header");
  }

  const bearerPrefix = "Bearer ";
  if (!authorizationHeader.startsWith(bearerPrefix)) {
    throw new UnauthorizedError("Authorization header must use Bearer token");
  }

  const token = authorizationHeader.slice(bearerPrefix.length).trim();
  if (!token) {
    throw new UnauthorizedError("Bearer token is required");
  }

  let claims;
  try {
    claims = verifyAccessToken(token, jwtAccessTokenSecret);
  } catch (error: unknown) {
    if (error instanceof AuthTokenError) {
      throw new UnauthorizedError(error.message);
    }

    throw error;
  }

  const role = parseRole(claims.role);
  if (!role) {
    throw new ForbiddenError("Token role is not recognized by server RBAC");
  }

  return {
    userId: claims.sub,
    role,
    stationId: claims.stationId,
  };
};

const assertRoleAllowedByPolicy = (
  principal: AuthenticatedPrincipal,
  policy: RouteGuardPolicy
): void => {
  if (!policy.allowedRoles.has(principal.role)) {
    throw new ForbiddenError("Authenticated role is not allowed for this route");
  }
};

const resolveAuthorizedPrincipalForRoute = (
  context: AppRequestContext,
  request: IncomingMessage,
  jwtAccessTokenSecret: string,
  policy: RouteGuardPolicy
): AuthenticatedPrincipal => {
  const principal = getAuthenticatedPrincipal(request, jwtAccessTokenSecret);
  context.principal = principal;
  assertRoleAllowedByPolicy(principal, policy);
  return principal;
};

const mapPrincipalToQueueActor = (
  principal: AuthenticatedPrincipal
): QueueActor => {
  return {
    actorType: "USER",
    actorUserId: principal.userId,
    stationId: principal.stationId,
  };
};

const getAuthorizedTellerActor = (
  context: AppRequestContext,
  request: IncomingMessage,
  jwtAccessTokenSecret: string
): QueueActor => {
  const principal = resolveAuthorizedPrincipalForRoute(
    context,
    request,
    jwtAccessTokenSecret,
    {
      allowedRoles: TELLER_ROUTE_ALLOWED_ROLES,
    }
  );

  return mapPrincipalToQueueActor(principal);
};

const requireStationId = (actor: QueueActor): string => {
  if (!actor.stationId || actor.stationId.trim().length === 0) {
    throw new ForbiddenError("Authenticated actor is not bound to a station");
  }

  return actor.stationId;
};

const requireString = (payload: JsonRecord, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestValidationError(`${key} must be a non-empty string`);
  }

  return value;
};

const requireNumber = (payload: JsonRecord, key: string): number => {
  const value = payload[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new RequestValidationError(`${key} must be a valid number`);
  }

  return value;
};

const optionalNumber = (payload: JsonRecord, key: string): number | undefined => {
  const value = payload[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new RequestValidationError(`${key} must be a valid number when provided`);
  }

  return value;
};

const requireNonNegativeInteger = (payload: JsonRecord, key: string): number => {
  const value = requireNumber(payload, key);
  if (!Number.isInteger(value) || value < 0) {
    throw new RequestValidationError(`${key} must be a non-negative integer`);
  }
  return value;
};

const optionalNonNegativeInteger = (payload: JsonRecord, key: string): number | undefined => {
  const value = optionalNumber(payload, key);
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new RequestValidationError(`${key} must be a non-negative integer when provided`);
  }
  return value;
};

const optionalBoolean = (payload: JsonRecord, key: string): boolean | undefined => {
  const value = payload[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${key} must be a boolean when provided`);
  }

  return value;
};

const optionalString = (payload: JsonRecord, key: string): string | undefined => {
  const value = payload[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RequestValidationError(`${key} must be a string when provided`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RequestValidationError(`${key} must not be an empty string`);
  }

  return trimmed;
};

const optionalRole = (payload: JsonRecord, key: string): AppRole | undefined => {
  const rawRole = optionalString(payload, key);
  if (!rawRole) {
    return undefined;
  }

  const role = parseRole(rawRole);
  if (!role) {
    throw new RequestValidationError(`${key} must be a valid AppRole`);
  }

  return role;
};

const parseCallNextPayload = (payload: JsonRecord): ParsedCallNextPayload => {
  return {
    serviceId: requireString(payload, "serviceId"),
  };
};

const parseTicketActionPayload = (
  payload: JsonRecord
): ParsedTicketActionPayload => {
  return {
    ticketId: requireString(payload, "ticketId"),
  };
};

const parseTransferPayload = (payload: JsonRecord): ParsedTransferPayload => {
  const destinationPayload = asRecord(payload.destination);
  if (!destinationPayload) {
    throw new RequestValidationError("destination is required");
  }

  const SERVER_OWNED_DESTINATION_FIELDS = ["sequenceNumber", "ticketNumber", "id", "createdAt", "updatedAt"];
  for (const field of SERVER_OWNED_DESTINATION_FIELDS) {
    if (field in destinationPayload) {
      throw new RequestValidationError(`destination.${field} is server-managed and must not be supplied by the client`);
    }
  }

  const ticketDateRaw = requireString(destinationPayload, "ticketDate");
  const ticketDate = new Date(ticketDateRaw);
  if (Number.isNaN(ticketDate.getTime())) {
    throw new RequestValidationError(
      "destination.ticketDate must be a valid ISO date string"
    );
  }

  return {
    ticketId: requireString(payload, "ticketId"),
    destination: {
      departmentId: requireString(destinationPayload, "departmentId"),
      serviceId: requireString(destinationPayload, "serviceId"),
      ticketDate,
    },
    reasonId: requireString(payload, "reasonId"),
  };
};

const parseChangePriorityPayload = (
  payload: JsonRecord
): ParsedChangePriorityPayload => {
  const priorityWeight = requireNumber(payload, "priorityWeight");

  return {
    ticketId: requireString(payload, "ticketId"),
    priorityCategoryId: requireString(payload, "priorityCategoryId"),
    priorityWeight,
  };
};

const parseAdminTransferReasonPayload = (
  payload: JsonRecord
): ParsedAdminTransferReasonPayload => {
  const isActive = payload.isActive;
  if (typeof isActive !== "boolean") {
    throw new RequestValidationError("isActive must be a boolean");
  }

  return {
    nameEn: requireString(payload, "nameEn"),
    nameAr: requireString(payload, "nameAr"),
    sortOrder: requireNonNegativeInteger(payload, "sortOrder"),
    isActive,
  };
};

const parseAdminTransferReasonPatchPayload = (
  payload: JsonRecord
): ParsedAdminTransferReasonPatchPayload => {
  const result: ParsedAdminTransferReasonPatchPayload = {
    nameEn: optionalString(payload, "nameEn"),
    nameAr: optionalString(payload, "nameAr"),
    sortOrder: optionalNonNegativeInteger(payload, "sortOrder"),
    isActive: optionalBoolean(payload, "isActive"),
  };

  if (
    result.nameEn === undefined &&
    result.nameAr === undefined &&
    result.sortOrder === undefined &&
    result.isActive === undefined
  ) {
    throw new RequestValidationError(
      "At least one field (nameEn, nameAr, sortOrder, isActive) must be provided"
    );
  }

  return result;
};

const parseLoginPayload = (payload: JsonRecord): ParsedLoginPayload => {
  return {
    email: requireString(payload, "email"),
    password: requireString(payload, "password"),
    stationId: optionalString(payload, "stationId"),
    requestedRole: optionalRole(payload, "requestedRole"),
  };
};

const parseRefreshPayload = (payload: JsonRecord): ParsedRefreshPayload => {
  return {
    refreshToken: requireString(payload, "refreshToken"),
    stationId: optionalString(payload, "stationId"),
    requestedRole: optionalRole(payload, "requestedRole"),
  };
};

const parseLogoutPayload = (payload: JsonRecord): ParsedLogoutPayload => {
  return {
    refreshToken: requireString(payload, "refreshToken"),
  };
};

const MIN_NEW_PASSWORD_LENGTH = 8;

const parseChangePasswordPayload = (
  payload: JsonRecord
): ParsedChangePasswordPayload => {
  const currentPassword = requireString(payload, "currentPassword");
  const newPassword = requireString(payload, "newPassword");
  if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
    throw new RequestValidationError(
      `newPassword must be at least ${MIN_NEW_PASSWORD_LENGTH} characters`
    );
  }
  if (newPassword === currentPassword) {
    throw new RequestValidationError(
      "newPassword must differ from currentPassword"
    );
  }
  return { currentPassword, newPassword, name: optionalString(payload, "name") };
};

const parseAdminConfigTemplatePayload = (
  payload: JsonRecord
): ParsedAdminConfigTemplatePayload => {
  return {
    templateKey: requireString(payload, "templateKey"),
    language: requireString(payload, "language"),
    content: requireString(payload, "content"),
  };
};

const parseAdminConfigMappingPayload = (
  payload: JsonRecord
): ParsedAdminConfigMappingPayload => {
  return {
    stationId: requireString(payload, "stationId"),
    deviceId: requireString(payload, "deviceId"),
  };
};

const parseAdminConfigRetentionPayload = (
  payload: JsonRecord
): ParsedAdminConfigRetentionPayload => {
  const retentionDays = requireNumber(payload, "retentionDays");
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new RequestValidationError("retentionDays must be a positive integer");
  }

  return {
    retentionDays,
  };
};

const parseAdminConfigResetPayload = (
  payload: JsonRecord
): ParsedAdminConfigResetPayload => {
  return {
    serviceId: requireString(payload, "serviceId"),
  };
};

const parseKioskIssueTicketPayload = (
  payload: JsonRecord
): ParsedKioskIssueTicketPayload => {
  const phoneNumber = requireString(payload, "phoneNumber");
  const phoneDigitsOnly = phoneNumber.replace(/\D/g, "");
  if (phoneDigitsOnly.length < 7 || phoneDigitsOnly.length > 15) {
    throw new RequestValidationError(
      "phoneNumber must be a valid phone number (7–15 digits)"
    );
  }

  return {
    departmentId: requireString(payload, "departmentId"),
    serviceId: requireString(payload, "serviceId"),
    phoneNumber: phoneDigitsOnly,
  };
};

/**
 * Returns the start-of-day bucket for the given timezone as a UTC Date.
 * Uses the local calendar date in the target timezone, stored as midnight UTC
 * so all tickets issued on the same local calendar day share the same bucket.
 */
const getTicketDateBucket = (timezone: string): Date => {
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return new Date(localDateStr + "T00:00:00.000Z");
};

/**
 * Returns a privacy-masked version of a phone number.
 * e.g. "0551234567" → "05****4567"
 */
const maskPhone = (phone: string): string => {
  if (phone.length <= 6) return phone;
  const first2 = phone.slice(0, 2);
  const last4 = phone.slice(-4);
  return first2 + "*".repeat(phone.length - 6) + last4;
};

const getStringProperty = (
  value: unknown,
  key: string
): string | undefined => {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : undefined;
};

const isSuccessfulResponse = (status: number): boolean =>
  status >= 200 && status < 300;

const extractRealtimeServiceId = (
  resultBody: unknown,
  fallbackServiceId?: string
): string | undefined => {
  const bodyRecord = asRecord(resultBody);
  const destinationServiceId = getStringProperty(
    bodyRecord?.destinationTicket,
    "serviceId"
  );
  const directServiceId = getStringProperty(bodyRecord, "serviceId");
  const sourceServiceId = getStringProperty(bodyRecord?.sourceTicket, "serviceId");

  return (
    destinationServiceId ??
    directServiceId ??
    sourceServiceId ??
    fallbackServiceId
  );
};

const extractRealtimeTicketId = (resultBody: unknown): string | undefined => {
  const bodyRecord = asRecord(resultBody);

  return (
    getStringProperty(resultBody, "id") ??
    getStringProperty(resultBody, "ticketId") ??
    getStringProperty(bodyRecord?.destinationTicket, "id") ??
    getStringProperty(bodyRecord?.sourceTicket, "id")
  );
};

const NOW_SERVING_MUTATION_OPERATIONS = new Set<string>([
  "teller.call-next",
  "teller.recall",
  "teller.start-serving",
  "teller.complete",
  "teller.skip-no-show",
  "teller.transfer",
]);

const shouldEmitNowServingUpdate = (operation: string): boolean =>
  NOW_SERVING_MUTATION_OPERATIONS.has(operation);

const emitRealtimeForSuccessfulTellerMutation = (
  broadcaster: QueueRealtimeBroadcaster,
  input: RealtimeEmitInput
): void => {
  if (!isSuccessfulResponse(input.result.status)) {
    return;
  }

  const responseBody = asRecord(input.result.body);
  if (!responseBody) {
    console.warn("[realtime] Skipping broadcast due to malformed successful response body", {
      requestId: input.context.requestId,
      operation: input.operation,
      status: input.result.status,
    });
    return;
  }

  const ticketId = extractRealtimeTicketId(responseBody);
  const serviceId = extractRealtimeServiceId(responseBody, input.fallbackServiceId);

  if (!ticketId && !serviceId) {
    console.warn("[realtime] Skipping broadcast due to missing realtime identifiers", {
      requestId: input.context.requestId,
      operation: input.operation,
      status: input.result.status,
    });
    return;
  }

  const event = {
    requestId: input.context.requestId,
    operation: input.operation,
    ticketId,
    serviceId,
    stationId: input.actor.stationId,
    occurredAt: new Date().toISOString(),
  };

  try {
    broadcaster.broadcastQueueUpdated(event);

    if (shouldEmitNowServingUpdate(input.operation)) {
      broadcaster.broadcastNowServingUpdated(event);
    }
  } catch (error: unknown) {
    console.error("[realtime] Broadcast failed", {
      requestId: input.context.requestId,
      operation: input.operation,
      error,
    });
  }
};

export const __serverTestables = {
  extractRealtimeServiceId,
  extractRealtimeTicketId,
  shouldEmitNowServingUpdate,
  assertRoleAllowedByPolicy,
  mapPrincipalToQueueActor,
  TELLER_ROUTE_ALLOWED_ROLES,
  parseKioskIssueTicketPayload,
  getTicketDateBucket,
};

const withPayload = async <TPayload>(
  context: AppRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
  parse: (payload: JsonRecord) => TPayload,
  handler: (payload: TPayload, context: AppRequestContext) => Promise<HttpResponse>
): Promise<void> => {
  try {
    const payload = await readJsonBody(request);
    const parsedPayload = parse(payload);
    const result = await handler(parsedPayload, context);
    json(response, result.status, result.body);
  } catch (error: unknown) {
    if (error instanceof PayloadTooLargeError) {
      payloadTooLarge(response, error.message);
      return;
    }

    if (error instanceof UnauthorizedError) {
      unauthorized(response, error.message);
      return;
    }

    if (error instanceof ForbiddenError) {
      forbidden(response, error.message);
      return;
    }

    if (error instanceof NotFoundError) {
      notFound(response, error.message);
      return;
    }

    if (error instanceof TooManyRequestsError) {
      tooManyRequests(response, error.message);
      return;
    }

    if (error instanceof SyntaxError) {
      invalidRequest(response, "Invalid JSON payload");
      return;
    }

    if (error instanceof RequestValidationError) {
      invalidRequest(response, error.message);
      return;
    }

    if (error instanceof LoginError) {
      json(response, error.status, {
        code: error.code,
        message: error.message,
      });
      return;
    }

    if (error instanceof RefreshError) {
      json(response, error.status, {
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[api] Unhandled internal error", {
      requestId: context.requestId,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    });
    internalServerError(response);
  }
};

const withAuthorizedTellerPayload = async <TPayload>(
  context: AppRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
  parse: (payload: JsonRecord) => TPayload,
  jwtAccessTokenSecret: string,
  handler: (payload: TPayload, actor: QueueActor) => Promise<HttpResponse>
): Promise<void> => {
  await withPayload(context, request, response, parse, (payload) => {
    const actor = getAuthorizedTellerActor(context, request, jwtAccessTokenSecret);
    return handler(payload, actor);
  });
};

const withAuthorizedPayload = async <TPayload>(
  context: AppRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
  parse: (payload: JsonRecord) => TPayload,
  jwtAccessTokenSecret: string,
  policy: RouteGuardPolicy,
  handler: (
    payload: TPayload,
    principal: AuthenticatedPrincipal,
    context: AppRequestContext
  ) => Promise<HttpResponse>
): Promise<void> => {
  await withPayload(context, request, response, parse, (payload, innerContext) => {
    const principal = resolveAuthorizedPrincipalForRoute(
      innerContext,
      request,
      jwtAccessTokenSecret,
      policy
    );

    return handler(payload, principal, innerContext);
  });
};

const withAuthorizedNoPayload = async (
  context: AppRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
  jwtAccessTokenSecret: string,
  policy: RouteGuardPolicy,
  handler: (
    principal: AuthenticatedPrincipal,
    context: AppRequestContext
  ) => Promise<HttpResponse>
): Promise<void> => {
  try {
    const principal = resolveAuthorizedPrincipalForRoute(
      context,
      request,
      jwtAccessTokenSecret,
      policy
    );

    const result = await handler(principal, context);
    json(response, result.status, result.body);
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      unauthorized(response, error.message);
      return;
    }

    if (error instanceof ForbiddenError) {
      forbidden(response, error.message);
      return;
    }

    if (error instanceof NotFoundError) {
      notFound(response, error.message);
      return;
    }

    if (error instanceof RequestValidationError) {
      invalidRequest(response, error.message);
      return;
    }

    internalServerError(response);
  }
};

const resolvePrincipalAccessScope = async (
  prismaClient: PrismaClient,
  principal: AuthenticatedPrincipal
): Promise<PrincipalAccessScope> => {
  const user = await prismaClient.user.findUnique({
    where: {
      id: principal.userId,
    },
    select: {
      hospitalId: true,
      roleAssignments: {
        where: {
          role: AppRole.MANAGER,
        },
        select: {
          departmentId: true,
        },
      },
    },
  });

  if (!user) {
    throw new ForbiddenError("Authenticated user is not available in persistence layer");
  }

  let managerDepartmentId: string | undefined;

  if (principal.role === AppRole.MANAGER) {
    if (user.roleAssignments.length !== 1) {
      throw new ForbiddenError(
        "Manager role assignment must be scoped to exactly one department"
      );
    }

    const assignmentDepartmentId = user.roleAssignments[0]?.departmentId;
    if (
      typeof assignmentDepartmentId !== "string" ||
      assignmentDepartmentId.trim().length === 0
    ) {
      throw new ForbiddenError(
        "Manager role assignment must be scoped to exactly one department"
      );
    }

    managerDepartmentId = assignmentDepartmentId;
  }

  return {
    principal,
    hospitalId: user.hospitalId,
    managerDepartmentId,
  };
};

const assertManagerDepartmentScope = (
  scope: PrincipalAccessScope,
  targetDepartmentId: string
): void => {
  if (scope.principal.role !== AppRole.MANAGER) {
    return;
  }

  if (!scope.managerDepartmentId || scope.managerDepartmentId !== targetDepartmentId) {
    throw new ForbiddenError("Manager access is limited to the assigned department");
  }
};

const extractRetentionDaysFromAuditEntry = (
  value: unknown
): number | undefined => {
  const record = asRecord(value);
  const retentionDays = record?.retentionDays;

  return typeof retentionDays === "number" && Number.isInteger(retentionDays)
    ? retentionDays
    : undefined;
};

export interface ApiSecurityConfig {
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
  jwtAccessTokenExpiresInSeconds: number;
  jwtRefreshTokenExpiresInSeconds: number;
}

export interface ApiRequestHandlerOptions {
  realtimeBroadcaster?: QueueRealtimeBroadcaster;
  /**
   * CORS allowed origins for HTTP API responses.
   * Defaults to '*' in development (NODE_ENV !== 'production').
   * In production, set CORS_ALLOWED_ORIGINS as a comma-separated list.
   */
  corsAllowedOrigins?: "*" | string[];
}

export type ApiRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

export const createApiRequestHandler = (
  prismaClient: PrismaClient,
  securityConfig: ApiSecurityConfig,
  options?: ApiRequestHandlerOptions
): ApiRequestHandler => {
  const tellerHandlers = createTellerApiHandlers(prismaClient);
  const queueEngineService = createQueueEngineService({ prismaClient });
  const realtimeBroadcaster =
    options?.realtimeBroadcaster ?? new NoopQueueRealtimeBroadcaster();

  const nodeEnv = (process.env.NODE_ENV ?? "").toLowerCase();
  const rawCorsEnv = process.env.CORS_ALLOWED_ORIGINS?.trim();
  const corsAllowedOrigins: "*" | string[] =
    options?.corsAllowedOrigins ??
    (rawCorsEnv === "*"
      ? "*"
      : rawCorsEnv
        ? rawCorsEnv.split(",").map((o) => o.trim()).filter(Boolean)
        : nodeEnv === "production" ? [] : "*");

  const applyCorsHeaders = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = getHeader(req, "origin") ?? "";
    let allowOrigin: string;

    if (corsAllowedOrigins === "*") {
      allowOrigin = "*";
    } else if (corsAllowedOrigins.includes(origin)) {
      allowOrigin = origin;
      res.setHeader("Vary", "Origin");
    } else {
      return; // Origin not allowed — don't set CORS headers
    }

    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  return async (request, response) => {
    const requestContext = createRequestContext(request);
    response.setHeader(REQUEST_ID_HEADER, requestContext.requestId);
    applyCorsHeaders(request, response);

    const method = request.method ?? "";
    const path = request.url?.split("?")[0] ?? "";

    // Handle CORS preflight
    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (method === "GET" && path === "/health") {
      json(response, 200, {
        status: "ok",
      });
      return;
    }

    // ── Teller device-binding resolution (public — no auth required) ─────────
    // Called by the Teller Electron app on startup to resolve the local Device ID
    // → CounterStation → Service chain before the user logs in.

    if (method === "GET" && path === "/teller/station") {
      const rawQuery = request.url?.includes("?")
        ? request.url.split("?")[1]
        : "";
      const queryParams = new URLSearchParams(rawQuery);
      const rawDeviceId = queryParams.get("deviceId");

      if (!rawDeviceId || rawDeviceId.trim().length === 0) {
        invalidRequest(response, "deviceId query parameter is required");
        return;
      }

      try {
        const device = await prismaClient.device.findUnique({
          where: { deviceId: rawDeviceId.trim() },
          select: {
            isActive: true,
            assignedCounterStationId: true,
            counterStation: {
              select: {
                id: true,
                counterCode: true,
                isActive: true,
                serviceId: true,
                service: {
                  select: {
                    id: true,
                    nameEn: true,
                    nameAr: true,
                    ticketPrefix: true,
                    departmentId: true,
                    isActive: true,
                    department: {
                      select: { id: true, nameEn: true, nameAr: true },
                    },
                  },
                },
              },
            },
          },
        });

        if (!device) {
          json(response, 404, {
            code: "DEVICE_NOT_CONFIGURED",
            message: "Device is not registered. Please ask IT to register this device in the Admin app.",
          });
          return;
        }

        if (!device.isActive) {
          json(response, 404, {
            code: "DEVICE_NOT_CONFIGURED",
            message: "This device has been disabled. Please contact IT.",
          });
          return;
        }

        if (!device.counterStation) {
          json(response, 404, {
            code: "DEVICE_NOT_CONFIGURED",
            message: "Device is not assigned to a station. Please ask IT to assign this device to a counter station.",
          });
          return;
        }

        const { counterStation: station } = device;

        if (!station.isActive || !station.service.isActive) {
          json(response, 404, {
            code: "DEVICE_NOT_CONFIGURED",
            message: "The counter station or its service is currently inactive. Please contact IT.",
          });
          return;
        }

        json(response, 200, {
          stationId: station.id,
          counterCode: station.counterCode,
          serviceId: station.serviceId,
          serviceNameEn: station.service.nameEn,
          serviceNameAr: station.service.nameAr,
          ticketPrefix: station.service.ticketPrefix,
          departmentId: station.service.departmentId,
          departmentNameEn: station.service.department.nameEn,
          departmentNameAr: station.service.department.nameAr,
        });
      } catch {
        internalServerError(response);
      }
      return;
    }

    // ── Kiosk public endpoints (no auth required) ─────────────────────────────

    if (method === "GET" && path === "/departments") {
      try {
        // Each instance serves one hospital; resolve it from any active department
        const hospital = await prismaClient.hospital.findFirst({
          where: { departments: { some: { isActive: true } } },
          select: { id: true },
        });

        if (!hospital) {
          json(response, 200, []);
          return;
        }

        const departments = await prismaClient.department.findMany({
          where: { hospitalId: hospital.id, isActive: true },
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true },
        });

        json(response, 200, departments);
      } catch {
        internalServerError(response);
      }
      return;
    }

    const servicesPathMatch = path.match(/^\/departments\/([^/]+)\/services$/);
    if (method === "GET" && servicesPathMatch) {
      const departmentId = servicesPathMatch[1];
      try {
        const services = await prismaClient.service.findMany({
          where: { departmentId, isActive: true },
          orderBy: { nameEn: "asc" },
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            ticketPrefix: true,
            estimatedWaitMinutes: true,
          },
        });

        json(response, 200, services);
      } catch {
        internalServerError(response);
      }
      return;
    }

    if (method === "POST" && path === "/tickets") {
      await withPayload(
        requestContext,
        request,
        response,
        parseKioskIssueTicketPayload,
        async (payload) => {
          // 1. Resolve service → department → hospital
          const service = await prismaClient.service.findFirst({
            where: { id: payload.serviceId, isActive: true },
            include: {
              department: {
                include: { hospital: { select: { id: true, timezone: true } } },
              },
            },
          });

          if (!service) {
            return { status: 404, body: { code: "SERVICE_NOT_FOUND", message: "Service not found or inactive" } };
          }

          if (service.department.id !== payload.departmentId) {
            return { status: 400, body: { code: "DEPARTMENT_SERVICE_MISMATCH", message: "Service does not belong to the given department" } };
          }

          const hospital = service.department.hospital;
          const ticketDate = getTicketDateBucket(hospital.timezone);

          // 2. Default priority (lowest weight = Normal)
          const defaultPriority = await prismaClient.priorityCategory.findFirst({
            where: { hospitalId: hospital.id },
            orderBy: { weight: "asc" },
            select: { id: true, weight: true },
          });

          if (!defaultPriority) {
            return { status: 422, body: { code: "NO_PRIORITY_CONFIGURED", message: "No priority categories configured for this hospital" } };
          }

          // 3. Issue ticket via queue engine (locking, sequencing, duplicate guard, event)
          let ticket: QueueTicket;
          try {
            ticket = await queueEngineService.issueKioskTicket({
              hospitalId: hospital.id,
              departmentId: payload.departmentId,
              serviceId: payload.serviceId,
              ticketDate,
              phoneNumber: payload.phoneNumber,
              priorityCategoryId: defaultPriority.id,
              priorityWeight: defaultPriority.weight,
              actor: { actorType: "KIOSK" },
            });
          } catch (error: unknown) {
            if (
              error instanceof QueueEngineError &&
              error.code === "DUPLICATE_ACTIVE_TICKET"
            ) {
              return {
                status: 409,
                body: {
                  code: "DUPLICATE_ACTIVE_TICKET",
                  message: "An active ticket already exists for this phone number in this service",
                },
              };
            }
            if (
              error instanceof QueueEngineError &&
              error.code === "SERVICE_NOT_FOUND"
            ) {
              return {
                status: 404,
                body: { code: "SERVICE_NOT_FOUND", message: "Service not found or inactive" },
              };
            }
            throw error;
          }

          // 4. Queue snapshot — tickets ahead with equal or higher priority weight
          // Count tickets that will be served before this one under the
          // documented ordering rule: priority first, FIFO within priority.
          //   - Any active ticket with a strictly higher priority weight goes first.
          //   - Among tickets with the same priority weight, earlier sequenceNumber
          //     (within the same day bucket) goes first.
          const peopleAhead = await prismaClient.ticket.count({
            where: {
              serviceId: payload.serviceId,
              ticketDate,
              status: { in: ["WAITING", "CALLED"] },
              OR: [
                // Higher priority — always ahead regardless of creation time
                { priorityCategory: { weight: { gt: ticket.priorityWeight } } },
                // Same priority — ahead only if issued before this ticket (FIFO)
                {
                  priorityCategory: { weight: { equals: ticket.priorityWeight } },
                  sequenceNumber: { lt: ticket.sequenceNumber },
                },
              ],
            },
          });

          // Notify teller dashboards about the new queue entry (fire-and-forget)
          try {
            realtimeBroadcaster.broadcastQueueUpdated({
              requestId: requestContext.requestId,
              operation: "kiosk.ticket-created",
              ticketId: ticket.id,
              serviceId: ticket.serviceId,
              stationId: undefined,
              occurredAt: new Date().toISOString(),
            });
          } catch (broadcastError: unknown) {
            console.error("[realtime] Failed to broadcast kiosk ticket created", {
              requestId: requestContext.requestId,
              error: broadcastError,
            });
          }

          return {
            status: 201,
            body: {
              ticket: {
                id: ticket.id,
                ticketNumber: ticket.ticketNumber,
                serviceId: ticket.serviceId,
                departmentId: ticket.departmentId,
                phoneNumber: ticket.phoneNumber,
              },
              queueSnapshot: {
                peopleAhead,
                estimatedWaitMinutes: service.estimatedWaitMinutes ?? null,
              },
              // Phase 8: replace with real WhatsApp opt-in deep-link
              whatsappOptInQrUrl: null,
              issuedAt: ticket.createdAt.toISOString(),
            },
          };
        }
      );
      return;
    }

    // ── End kiosk public endpoints ─────────────────────────────────────────────

    // ── Queue read endpoints (STAFF / MANAGER / ADMIN — bearer auth required) ──

    const queueSummaryPathMatch = path.match(
      /^\/queue\/services\/([^/]+)\/summary$/
    );
    if (method === "GET" && queueSummaryPathMatch) {
      const serviceId = queueSummaryPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: TELLER_ROUTE_ALLOWED_ROLES },
        async (principal, context) => {
          // Resolve service → department → hospital (for timezone + validation).
          const service = await prismaClient.service.findFirst({
            where: { id: serviceId, isActive: true },
            select: {
              department: {
                select: {
                  hospital: { select: { id: true, timezone: true } },
                },
              },
            },
          });

          if (!service) {
            return {
              status: 404,
              body: { code: "SERVICE_NOT_FOUND", message: "Service not found or inactive" },
            };
          }

          const ticketDate = getTicketDateBucket(
            service.department.hospital.timezone
          );

          // Run all counts + now-serving lookup in parallel.
          const [
            waitingCount,
            calledCount,
            servingCount,
            completedToday,
            noShowsToday,
            nowServingRow,
          ] = await Promise.all([
            prismaClient.ticket.count({
              where: { serviceId, ticketDate, status: "WAITING" },
            }),
            prismaClient.ticket.count({
              where: { serviceId, ticketDate, status: "CALLED" },
            }),
            prismaClient.ticket.count({
              where: { serviceId, ticketDate, status: "SERVING" },
            }),
            prismaClient.ticket.count({
              where: { serviceId, ticketDate, status: "COMPLETED" },
            }),
            prismaClient.ticket.count({
              where: { serviceId, ticketDate, status: "NO_SHOW" },
            }),
            // nowServing is scoped to the requesting teller's station (from JWT).
            principal.stationId
              ? prismaClient.ticket.findFirst({
                  where: {
                    serviceId,
                    calledCounterStationId: principal.stationId,
                    status: { in: ["CALLED", "SERVING"] },
                  },
                  include: { priorityCategory: { select: { weight: true } } },
                })
              : Promise.resolve(null),
          ]);

          const nowServing = nowServingRow
            ? {
                id: nowServingRow.id,
                ticketNumber: nowServingRow.ticketNumber,
                status: nowServingRow.status as string,
                serviceId: nowServingRow.serviceId,
                stationId: nowServingRow.calledCounterStationId ?? undefined,
                priorityWeight: nowServingRow.priorityCategory.weight,
                calledAt: nowServingRow.calledAt?.toISOString() ?? undefined,
                servingStartedAt:
                  nowServingRow.servingStartedAt?.toISOString() ?? undefined,
                completedAt:
                  nowServingRow.completedAt?.toISOString() ?? undefined,
                createdAt: nowServingRow.createdAt.toISOString(),
                originTicketId: nowServingRow.originTicketId ?? undefined,
                patientPhone: maskPhone(nowServingRow.phoneNumber),
              }
            : undefined;

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              serviceId,
              waitingCount,
              calledCount,
              servingCount,
              completedToday,
              noShowsToday,
              nowServing,
            },
          };
        }
      );
      return;
    }

    const queueWaitingPathMatch = path.match(
      /^\/queue\/services\/([^/]+)\/waiting$/
    );
    if (method === "GET" && queueWaitingPathMatch) {
      const serviceId = queueWaitingPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: TELLER_ROUTE_ALLOWED_ROLES },
        async (_principal, context) => {
          const service = await prismaClient.service.findFirst({
            where: { id: serviceId, isActive: true },
            select: {
              department: {
                select: {
                  hospital: { select: { id: true, timezone: true } },
                },
              },
            },
          });

          if (!service) {
            return {
              status: 404,
              body: { code: "SERVICE_NOT_FOUND", message: "Service not found or inactive" },
            };
          }

          const ticketDate = getTicketDateBucket(
            service.department.hospital.timezone
          );

          const rows = await prismaClient.ticket.findMany({
            where: { serviceId, ticketDate, status: "WAITING" },
            orderBy: [
              { priorityCategory: { weight: "desc" } },
              { sequenceNumber: "asc" },
            ],
            include: { priorityCategory: { select: { weight: true } } },
            take: 100,
          });

          const tickets = rows.map((row) => ({
            id: row.id,
            ticketNumber: row.ticketNumber,
            priorityWeight: row.priorityCategory.weight,
            createdAt: row.createdAt.toISOString(),
          }));

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              tickets,
            },
          };
        }
      );
      return;
    }

    // ── End queue read endpoints ────────────────────────────────────────────────

    if (method === "POST" && path === "/auth/login") {
      await withPayload(
        requestContext,
        request,
        response,
        parseLoginPayload,
        async (payload) => {
        applyLoginRateLimit(request, payload.email);

        const result = await loginWithPassword(prismaClient, payload, {
          jwtAccessTokenSecret: securityConfig.jwtAccessTokenSecret,
          jwtRefreshTokenSecret: securityConfig.jwtRefreshTokenSecret,
          accessTokenExpiresInSeconds:
            securityConfig.jwtAccessTokenExpiresInSeconds,
          refreshTokenExpiresInSeconds:
            securityConfig.jwtRefreshTokenExpiresInSeconds,
        });

        return {
          status: 200,
          body: result,
        };
      }
      );
      return;
    }

    if (method === "POST" && path === "/auth/refresh") {
      await withPayload(
        requestContext,
        request,
        response,
        parseRefreshPayload,
        async (payload) => {
          const result = await refreshAuthTokens(prismaClient, payload, {
            jwtAccessTokenSecret: securityConfig.jwtAccessTokenSecret,
            jwtRefreshTokenSecret: securityConfig.jwtRefreshTokenSecret,
            accessTokenExpiresInSeconds:
              securityConfig.jwtAccessTokenExpiresInSeconds,
            refreshTokenExpiresInSeconds:
              securityConfig.jwtRefreshTokenExpiresInSeconds,
          });

          return {
            status: 200,
            body: result,
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/auth/logout") {
      await withPayload(
        requestContext,
        request,
        response,
        parseLogoutPayload,
        async (payload) => {
          logoutWithRefreshTokenSkeleton(
            payload.refreshToken,
            securityConfig.jwtRefreshTokenSecret
          );

          return {
            status: 200,
            body: {
              success: true,
              revoked: false,
              message:
                "Logout accepted. Refresh-token revocation persistence is not yet enabled.",
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/auth/change-password") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseChangePasswordPayload,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: new Set(Object.values(AppRole)) },
        async (payload, principal) => {
          const user = await prismaClient.user.findUnique({
            where: { id: principal.userId },
            select: { id: true, passwordHash: true, isActive: true },
          });

          if (!user || !user.isActive) {
            throw new ForbiddenError("User not found or inactive");
          }

          const verification = await verifyPasswordHashWithMetadata(
            payload.currentPassword,
            user.passwordHash
          );

          if (!verification.isValid) {
            return {
              status: 400,
              body: {
                code: "INVALID_CREDENTIALS",
                message: "Current password is incorrect",
              },
            };
          }

          const newHash = await createArgon2idPasswordHash(payload.newPassword);

          await prismaClient.user.update({
            where: { id: user.id },
            data: {
              passwordHash: newHash,
              mustChangePassword: false,
              failedLoginAttempts: 0,
              lockedUntil: null,
              ...(payload.name !== undefined && { name: payload.name }),
            },
          });

          return {
            status: 200,
            body: { success: true },
          };
        }
      );
      return;
    }

    if (method === "GET" && path === "/admin/config/templates") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const templates = await prismaClient.messageTemplate.findMany({
            where: {
              hospitalId: scope.hospitalId,
            },
            orderBy: [
              {
                eventType: "asc",
              },
              {
                language: "asc",
              },
            ],
            select: {
              id: true,
              channel: true,
              eventType: true,
              language: true,
              content: true,
              isActive: true,
              updatedAt: true,
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              templates,
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/admin/config/templates") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminConfigTemplatePayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const template = await prismaClient.$transaction(async (tx) => {
            const persistedTemplate = await tx.messageTemplate.upsert({
              where: {
                hospitalId_channel_eventType_language: {
                  hospitalId: scope.hospitalId,
                  channel: TemplateChannel.WHATSAPP,
                  eventType: payload.templateKey,
                  language: payload.language,
                },
              },
              update: {
                content: payload.content,
                isActive: true,
              },
              create: {
                hospitalId: scope.hospitalId,
                channel: TemplateChannel.WHATSAPP,
                eventType: payload.templateKey,
                language: payload.language,
                content: payload.content,
                isActive: true,
              },
              select: {
                id: true,
                channel: true,
                eventType: true,
                language: true,
                content: true,
                isActive: true,
                updatedAt: true,
              },
            });

            await tx.auditLog.create({
              data: {
                hospitalId: scope.hospitalId,
                actorUserId: scope.principal.userId,
                action: "MESSAGE_TEMPLATE_UPSERTED",
                entityType: "MESSAGE_TEMPLATE",
                entityId: persistedTemplate.id,
                after: {
                  channel: persistedTemplate.channel,
                  eventType: persistedTemplate.eventType,
                  language: persistedTemplate.language,
                },
              },
            });

            return persistedTemplate;
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              template,
            },
          };
        }
      );
      return;
    }

    if (method === "GET" && path === "/admin/config/mapping") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const mappings = await prismaClient.device.findMany({
            where: {
              hospitalId: scope.hospitalId,
              assignedCounterStationId: {
                not: null,
              },
            },
            select: {
              id: true,
              deviceId: true,
              deviceType: true,
              displayName: true,
              assignedCounterStationId: true,
              counterStation: {
                select: {
                  id: true,
                  counterCode: true,
                  serviceId: true,
                },
              },
              updatedAt: true,
            },
            orderBy: {
              updatedAt: "desc",
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              mappings,
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/admin/config/mapping") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminConfigMappingPayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const station = await prismaClient.counterStation.findFirst({
            where: {
              id: payload.stationId,
              hospitalId: scope.hospitalId,
            },
            select: {
              id: true,
              counterCode: true,
            },
          });

          if (!station) {
            throw new RequestValidationError("stationId is not valid for the current hospital");
          }

          const device = await prismaClient.device.findFirst({
            where: {
              deviceId: payload.deviceId,
              hospitalId: scope.hospitalId,
            },
            select: {
              id: true,
              deviceId: true,
              displayName: true,
              deviceType: true,
            },
          });

          if (!device) {
            throw new RequestValidationError("deviceId is not valid for the current hospital");
          }

          const updatedMapping = await prismaClient.$transaction(async (tx) => {
            const persistedMapping = await tx.device.update({
              where: {
                id: device.id,
              },
              data: {
                assignedCounterStationId: station.id,
              },
              select: {
                id: true,
                deviceId: true,
                deviceType: true,
                displayName: true,
                assignedCounterStationId: true,
                updatedAt: true,
              },
            });

            await tx.auditLog.create({
              data: {
                hospitalId: scope.hospitalId,
                actorUserId: scope.principal.userId,
                action: "DEVICE_STATION_MAPPING_UPDATED",
                entityType: "DEVICE",
                entityId: device.id,
                after: {
                  stationId: station.id,
                  counterCode: station.counterCode,
                },
              },
            });

            return persistedMapping;
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              mapping: updatedMapping,
            },
          };
        }
      );
      return;
    }

    if (method === "GET" && path === "/admin/config/retention") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const latestRetentionPolicyChange = await prismaClient.auditLog.findFirst({
            where: {
              hospitalId: scope.hospitalId,
              action: "RETENTION_POLICY_UPDATED",
              entityType: "RETENTION_POLICY",
            },
            orderBy: {
              occurredAt: "desc",
            },
            select: {
              after: true,
              occurredAt: true,
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              retentionPolicy: {
                retentionDays: extractRetentionDaysFromAuditEntry(
                  latestRetentionPolicyChange?.after
                ),
                updatedAt: latestRetentionPolicyChange?.occurredAt ?? null,
              },
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/admin/config/retention") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminConfigRetentionPayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const auditRecord = await prismaClient.auditLog.create({
            data: {
              hospitalId: scope.hospitalId,
              actorUserId: scope.principal.userId,
              action: "RETENTION_POLICY_UPDATED",
              entityType: "RETENTION_POLICY",
              entityId: scope.hospitalId,
              after: {
                retentionDays: payload.retentionDays,
              },
            },
            select: {
              occurredAt: true,
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              retentionPolicy: {
                retentionDays: payload.retentionDays,
                updatedAt: auditRecord.occurredAt,
              },
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/admin/config/resets/service-counter") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminConfigResetPayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_RESETS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const targetService = await prismaClient.service.findFirst({
            where: {
              id: payload.serviceId,
              department: {
                hospitalId: scope.hospitalId,
              },
            },
            select: {
              id: true,
              departmentId: true,
              ticketPrefix: true,
            },
          });

          if (!targetService) {
            throw new RequestValidationError("serviceId is not valid for the current hospital");
          }

          assertManagerDepartmentScope(scope, targetService.departmentId);

          await prismaClient.auditLog.create({
            data: {
              hospitalId: scope.hospitalId,
              actorUserId: scope.principal.userId,
              action: "SERVICE_COUNTER_RESET_REQUESTED",
              entityType: "SERVICE",
              entityId: targetService.id,
              after: {
                serviceId: targetService.id,
                ticketPrefix: targetService.ticketPrefix,
              },
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              accepted: true,
              resetRequest: {
                serviceId: targetService.id,
              },
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/call-next") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseCallNextPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.callNext({
            serviceId: payload.serviceId,
            stationId: requireStationId(actor),
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.call-next",
            context: requestContext,
            actor,
            result,
            fallbackServiceId: payload.serviceId,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/recall") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.recall({
            ticketId: payload.ticketId,
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.recall",
            context: requestContext,
            actor,
            result,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/start-serving") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.startServing({
            ticketId: payload.ticketId,
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.start-serving",
            context: requestContext,
            actor,
            result,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/skip-no-show") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.skipNoShow({
            ticketId: payload.ticketId,
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.skip-no-show",
            context: requestContext,
            actor,
            result,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/complete") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.complete({
            ticketId: payload.ticketId,
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.complete",
            context: requestContext,
            actor,
            result,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/transfer") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseTransferPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          // Resolve the caller's hospital for tenant scoping
          const callerUser = await prismaClient.user.findUnique({
            where: { id: actor.actorUserId },
            select: { hospitalId: true },
          });
          if (!callerUser) {
            return failure(403, "FORBIDDEN", "Authenticated user not found");
          }

          // Resolve and validate the required transfer reason (scoped to caller's hospital)
          const reason = await prismaClient.transferReason.findFirst({
            where: { id: payload.reasonId, hospitalId: callerUser.hospitalId },
            select: { id: true, nameEn: true, nameAr: true, isActive: true },
          });
          if (!reason || !reason.isActive) {
            return failure(400, "INVALID_TRANSFER_REASON", "Transfer reason not found or inactive");
          }

          const result = await tellerHandlers.transfer({
            ticketId: payload.ticketId,
            destination: payload.destination,
            actor,
            reason: { id: reason.id, nameEn: reason.nameEn, nameAr: reason.nameAr },
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.transfer",
            context: requestContext,
            actor,
            result,
            fallbackServiceId: payload.destination.serviceId,
          });

          return result;
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/change-priority") {
      await withAuthorizedTellerPayload(
        requestContext,
        request,
        response,
        parseChangePriorityPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          const result = await tellerHandlers.changePriority({
            ticketId: payload.ticketId,
            priorityCategoryId: payload.priorityCategoryId,
            priorityWeight: payload.priorityWeight,
            actor,
          });

          emitRealtimeForSuccessfulTellerMutation(realtimeBroadcaster, {
            operation: "teller.change-priority",
            context: requestContext,
            actor,
            result,
          });

          return result;
        }
      );
      return;
    }

    // ── Admin ticket management (Admin + Manager) ─────────────────────────────

    // GET /admin/tickets/search?q=...&serviceId=...
    if (method === "GET" && path === "/admin/tickets/search") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const rawQuery = request.url?.includes("?")
            ? request.url.split("?")[1]
            : "";
          const queryParams = new URLSearchParams(rawQuery);
          const q = queryParams.get("q")?.trim() ?? "";
          const serviceId = queryParams.get("serviceId")?.trim() ?? undefined;

          if (!q || q.length < 2) {
            return {
              status: 400,
              body: { code: "INVALID_REQUEST", message: "Query parameter 'q' must be at least 2 characters" },
            };
          }

          // Ensure the search string is safe for LIKE patterns
          const safeTerm = q.replace(/[%_\\]/g, "\\$&");

          const where: Record<string, unknown> = {
            hospitalId: scope.hospitalId,
            OR: [
              { ticketNumber: { contains: safeTerm, mode: "insensitive" } },
              { phoneNumber: { contains: safeTerm } },
            ],
          };

          if (serviceId) {
            where.serviceId = serviceId;
          }

          // Manager scoping: restrict to assigned department
          if (scope.managerDepartmentId) {
            where.departmentId = scope.managerDepartmentId;
          }

          const rows = await prismaClient.ticket.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: 25,
            include: {
              priorityCategory: { select: { weight: true, nameEn: true, nameAr: true, code: true } },
              service: { select: { nameEn: true, nameAr: true } },
              department: { select: { nameEn: true, nameAr: true } },
            },
          });

          const tickets = rows.map((row) => ({
            id: row.id,
            ticketNumber: row.ticketNumber,
            phoneNumber: maskPhone(row.phoneNumber),
            status: row.status as string,
            serviceId: row.serviceId,
            serviceName: { en: row.service.nameEn, ar: row.service.nameAr },
            departmentId: row.departmentId,
            departmentName: { en: row.department.nameEn, ar: row.department.nameAr },
            priorityWeight: row.priorityCategory.weight,
            priorityCategory: {
              code: row.priorityCategory.code,
              nameEn: row.priorityCategory.nameEn,
              nameAr: row.priorityCategory.nameAr,
            },
            createdAt: row.createdAt.toISOString(),
            calledAt: row.calledAt?.toISOString() ?? null,
            servingStartedAt: row.servingStartedAt?.toISOString() ?? null,
            completedAt: row.completedAt?.toISOString() ?? null,
          }));

          return {
            status: 200,
            body: { requestId: context.requestId, tickets },
          };
        }
      );
      return;
    }

    // GET /admin/tickets/:ticketId
    const adminTicketDetailPathMatch = path.match(
      /^\/admin\/tickets\/([^/]+)$/
    );

    if (method === "GET" && adminTicketDetailPathMatch) {
      const ticketId = adminTicketDetailPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const row = await prismaClient.ticket.findFirst({
            where: { id: ticketId, hospitalId: scope.hospitalId },
            include: {
              priorityCategory: { select: { weight: true, nameEn: true, nameAr: true, code: true } },
              service: { select: { nameEn: true, nameAr: true } },
              department: { select: { nameEn: true, nameAr: true } },
              events: {
                orderBy: { occurredAt: "asc" },
                select: {
                  id: true,
                  eventType: true,
                  actorType: true,
                  actorUserId: true,
                  stationId: true,
                  payload: true,
                  occurredAt: true,
                },
              },
            },
          });

          if (!row) {
            throw new NotFoundError("Ticket not found");
          }

          // Manager scoping
          if (scope.managerDepartmentId && row.departmentId !== scope.managerDepartmentId) {
            throw new ForbiddenError("Manager access is limited to the assigned department");
          }

          const ticket = {
            id: row.id,
            ticketNumber: row.ticketNumber,
            phoneNumber: maskPhone(row.phoneNumber),
            status: row.status as string,
            sequenceNumber: row.sequenceNumber,
            serviceId: row.serviceId,
            serviceName: { en: row.service.nameEn, ar: row.service.nameAr },
            departmentId: row.departmentId,
            departmentName: { en: row.department.nameEn, ar: row.department.nameAr },
            priorityWeight: row.priorityCategory.weight,
            priorityCategory: {
              code: row.priorityCategory.code,
              nameEn: row.priorityCategory.nameEn,
              nameAr: row.priorityCategory.nameAr,
            },
            calledAt: row.calledAt?.toISOString() ?? null,
            servingStartedAt: row.servingStartedAt?.toISOString() ?? null,
            completedAt: row.completedAt?.toISOString() ?? null,
            noShowAt: row.noShowAt?.toISOString() ?? null,
            cancelledAt: row.cancelledAt?.toISOString() ?? null,
            calledCounterStationId: row.calledCounterStationId ?? null,
            lockedByUserId: row.lockedByUserId ?? null,
            lockedUntil: row.lockedUntil?.toISOString() ?? null,
            originTicketId: row.originTicketId ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            events: row.events.map((e) => ({
              id: e.id,
              eventType: e.eventType,
              actorType: e.actorType,
              actorUserId: e.actorUserId ?? null,
              stationId: e.stationId ?? null,
              payload: e.payload ?? null,
              occurredAt: e.occurredAt.toISOString(),
            })),
          };

          return {
            status: 200,
            body: { requestId: context.requestId, ticket },
          };
        }
      );
      return;
    }

    // POST /admin/tickets/:ticketId/lock
    const adminTicketLockPathMatch = path.match(
      /^\/admin\/tickets\/([^/]+)\/lock$/
    );
    if (method === "POST" && adminTicketLockPathMatch) {
      const ticketId = adminTicketLockPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const LOCK_DURATION_MS = 2 * 60 * 1000; // 2 minutes

          const result = await prismaClient.$transaction(async (tx) => {
            const ticket = await tx.ticket.findFirst({
              where: { id: ticketId, hospitalId: scope.hospitalId },
            });

            if (!ticket) {
              throw new NotFoundError("Ticket not found");
            }

            if (scope.managerDepartmentId && ticket.departmentId !== scope.managerDepartmentId) {
              throw new ForbiddenError("Manager access is limited to the assigned department");
            }

            if (ticket.status !== "WAITING") {
              throw new RequestValidationError("Only WAITING tickets can be locked for priority change");
            }

            // If already locked by another user and lock hasn't expired
            const now = new Date();
            if (
              ticket.lockedByUserId &&
              ticket.lockedByUserId !== principal.userId &&
              ticket.lockedUntil &&
              ticket.lockedUntil > now
            ) {
              return {
                status: 409 as const,
                body: {
                  code: "TICKET_LOCKED",
                  message: "Ticket is already locked by another user",
                  lockedByUserId: ticket.lockedByUserId,
                  lockedUntil: ticket.lockedUntil.toISOString(),
                },
              };
            }

            const lockedUntil = new Date(now.getTime() + LOCK_DURATION_MS);

            await tx.ticket.update({
              where: { id: ticketId },
              data: {
                lockedByUserId: principal.userId,
                lockedUntil,
              },
            });

            await tx.ticketEvent.create({
              data: {
                ticketId: ticket.id,
                eventType: "LOCKED",
                actorType: "USER",
                actorUserId: principal.userId,
                occurredAt: now,
                payload: { lockedUntil: lockedUntil.toISOString() },
              },
            });

            return {
              status: 200 as const,
              body: {
                requestId: context.requestId,
                ticketId: ticket.id,
                lockedByUserId: principal.userId,
                lockedUntil: lockedUntil.toISOString(),
              },
            };
          });

          return result;
        }
      );
      return;
    }

    // POST /admin/tickets/:ticketId/unlock
    const adminTicketUnlockPathMatch = path.match(
      /^\/admin\/tickets\/([^/]+)\/unlock$/
    );
    if (method === "POST" && adminTicketUnlockPathMatch) {
      const ticketId = adminTicketUnlockPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          await prismaClient.$transaction(async (tx) => {
            const ticket = await tx.ticket.findFirst({
              where: { id: ticketId, hospitalId: scope.hospitalId },
            });

            if (!ticket) {
              throw new NotFoundError("Ticket not found");
            }

            if (scope.managerDepartmentId && ticket.departmentId !== scope.managerDepartmentId) {
              throw new ForbiddenError("Manager access is limited to the assigned department");
            }

            // Only the lock owner (or admin) can unlock
            if (
              ticket.lockedByUserId &&
              ticket.lockedByUserId !== principal.userId &&
              principal.role !== AppRole.ADMIN
            ) {
              throw new ForbiddenError("Only the lock owner or an Admin can unlock this ticket");
            }

            await tx.ticket.update({
              where: { id: ticketId },
              data: {
                lockedByUserId: null,
                lockedUntil: null,
              },
            });

            await tx.ticketEvent.create({
              data: {
                ticketId: ticket.id,
                eventType: "UNLOCKED",
                actorType: "USER",
                actorUserId: principal.userId,
                occurredAt: new Date(),
              },
            });
          });

          return {
            status: 200,
            body: { requestId: context.requestId, success: true },
          };
        }
      );
      return;
    }

    // POST /admin/tickets/:ticketId/change-priority
    const adminChangePriorityPathMatch = path.match(
      /^\/admin\/tickets\/([^/]+)\/change-priority$/
    );
    if (method === "POST" && adminChangePriorityPathMatch) {
      const ticketId = adminChangePriorityPathMatch[1];
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        (payload: JsonRecord) => {
          const priorityCategoryId = requireString(payload, "priorityCategoryId");
          const priorityWeight = requireNumber(payload, "priorityWeight");
          return { priorityCategoryId, priorityWeight };
        },
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          // Verify ticket belongs to this hospital and manager scope
          const ticket = await prismaClient.ticket.findFirst({
            where: { id: ticketId, hospitalId: scope.hospitalId },
          });

          if (!ticket) {
            throw new NotFoundError("Ticket not found");
          }

          if (scope.managerDepartmentId && ticket.departmentId !== scope.managerDepartmentId) {
            throw new ForbiddenError("Manager access is limited to the assigned department");
          }

          // Lock validation, priority change, and lock release all happen
          // atomically inside the queue engine's transaction.
          const actor: QueueActor = {
            actorType: "USER",
            actorUserId: principal.userId,
          };

          try {
            await queueEngineService.changePriority({
              ticketId,
              priorityCategoryId: payload.priorityCategoryId,
              priorityWeight: payload.priorityWeight,
              actor,
              lockOwnerId: principal.userId,
            });
          } catch (error: unknown) {
            if (
              error instanceof QueueEngineError &&
              error.code === "TICKET_LOCKED_BY_OTHER"
            ) {
              throw new ForbiddenError("Ticket is locked by another user");
            }
            if (
              error instanceof QueueEngineError &&
              error.code === "PRIORITY_CHANGE_NOT_ALLOWED"
            ) {
              throw new RequestValidationError(error.message);
            }
            throw error;
          }

          // Broadcast queue update (fire-and-forget)
          try {
            realtimeBroadcaster.broadcastQueueUpdated({
              requestId: context.requestId,
              operation: "admin.change-priority",
              ticketId,
              serviceId: ticket.serviceId,
              stationId: undefined,
              occurredAt: new Date().toISOString(),
            });
          } catch {
            // fire-and-forget
          }

          return {
            status: 200,
            body: { requestId: context.requestId, success: true },
          };
        }
      );
      return;
    }

    // GET /admin/priority-categories
    if (method === "GET" && path === "/admin/priority-categories") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        { allowedRoles: ADMIN_QUEUE_ALLOWED_ROLES },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const categories = await prismaClient.priorityCategory.findMany({
            where: { hospitalId: scope.hospitalId },
            orderBy: { weight: "desc" },
            select: {
              id: true,
              code: true,
              nameEn: true,
              nameAr: true,
              weight: true,
            },
          });

          return {
            status: 200,
            body: { requestId: context.requestId, categories },
          };
        }
      );
      return;
    }

    // ── End admin ticket management ─────────────────────────────────────────

    // ── Transfer reasons ──────────────────────────────────────────────────────

    if (method === "GET" && path === "/transfer-reasons") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: TELLER_ROUTE_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const reasons = await prismaClient.transferReason.findMany({
            where: {
              hospitalId: scope.hospitalId,
              isActive: true,
            },
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              nameEn: true,
              nameAr: true,
              sortOrder: true,
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              reasons,
            },
          };
        }
      );
      return;
    }

    if (method === "GET" && path === "/admin/transfer-reasons") {
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);
          const reasons = await prismaClient.transferReason.findMany({
            where: {
              hospitalId: scope.hospitalId,
            },
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              nameEn: true,
              nameAr: true,
              sortOrder: true,
              isActive: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              reasons,
            },
          };
        }
      );
      return;
    }

    if (method === "POST" && path === "/admin/transfer-reasons") {
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminTransferReasonPayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const reason = await prismaClient.$transaction(async (tx) => {
            const created = await tx.transferReason.create({
              data: {
                hospitalId: scope.hospitalId,
                nameEn: payload.nameEn,
                nameAr: payload.nameAr,
                sortOrder: payload.sortOrder,
                isActive: payload.isActive,
              },
              select: {
                id: true,
                nameEn: true,
                nameAr: true,
                sortOrder: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await tx.auditLog.create({
              data: {
                hospitalId: scope.hospitalId,
                actorUserId: scope.principal.userId,
                action: "TRANSFER_REASON_CREATED",
                entityType: "TRANSFER_REASON",
                entityId: created.id,
                after: {
                  nameEn: created.nameEn,
                  nameAr: created.nameAr,
                  sortOrder: created.sortOrder,
                  isActive: created.isActive,
                },
              },
            });

            return created;
          });

          return {
            status: 201,
            body: {
              requestId: context.requestId,
              reason,
            },
          };
        }
      );
      return;
    }

    const adminTransferReasonPathMatch = path.match(
      /^\/admin\/transfer-reasons\/([^/]+)$/
    );

    if (method === "PATCH" && adminTransferReasonPathMatch) {
      const reasonId = adminTransferReasonPathMatch[1];
      await withAuthorizedPayload(
        requestContext,
        request,
        response,
        parseAdminTransferReasonPatchPayload,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (payload, principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          const reason = await prismaClient.$transaction(async (tx) => {
            const existing = await tx.transferReason.findUnique({
              where: { id: reasonId },
            });
            if (!existing || existing.hospitalId !== scope.hospitalId) {
              throw new NotFoundError("Transfer reason not found");
            }

            const data: Record<string, unknown> = {};
            if (payload.nameEn !== undefined) data.nameEn = payload.nameEn;
            if (payload.nameAr !== undefined) data.nameAr = payload.nameAr;
            if (payload.sortOrder !== undefined) data.sortOrder = payload.sortOrder;
            if (payload.isActive !== undefined) data.isActive = payload.isActive;

            const updated = await tx.transferReason.update({
              where: { id: reasonId },
              data,
              select: {
                id: true,
                nameEn: true,
                nameAr: true,
                sortOrder: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await tx.auditLog.create({
              data: {
                hospitalId: scope.hospitalId,
                actorUserId: scope.principal.userId,
                action: "TRANSFER_REASON_UPDATED",
                entityType: "TRANSFER_REASON",
                entityId: updated.id,
                before: {
                  nameEn: existing.nameEn,
                  nameAr: existing.nameAr,
                  sortOrder: existing.sortOrder,
                  isActive: existing.isActive,
                },
                after: {
                  nameEn: updated.nameEn,
                  nameAr: updated.nameAr,
                  sortOrder: updated.sortOrder,
                  isActive: updated.isActive,
                },
              },
            });

            return updated;
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              reason,
            },
          };
        }
      );
      return;
    }

    if (method === "DELETE" && adminTransferReasonPathMatch) {
      const reasonId = adminTransferReasonPathMatch[1];
      await withAuthorizedNoPayload(
        requestContext,
        request,
        response,
        securityConfig.jwtAccessTokenSecret,
        {
          allowedRoles: ADMIN_CONFIG_SETTINGS_ALLOWED_ROLES,
        },
        async (principal, context) => {
          const scope = await resolvePrincipalAccessScope(prismaClient, principal);

          await prismaClient.$transaction(async (tx) => {
            const existing = await tx.transferReason.findUnique({
              where: { id: reasonId },
            });
            if (!existing || existing.hospitalId !== scope.hospitalId) {
              throw new NotFoundError("Transfer reason not found");
            }

            await tx.transferReason.update({
              where: { id: reasonId },
              data: { isActive: false },
            });

            await tx.auditLog.create({
              data: {
                hospitalId: scope.hospitalId,
                actorUserId: scope.principal.userId,
                action: "TRANSFER_REASON_DELETED",
                entityType: "TRANSFER_REASON",
                entityId: reasonId,
                before: {
                  nameEn: existing.nameEn,
                  nameAr: existing.nameAr,
                  sortOrder: existing.sortOrder,
                  isActive: existing.isActive,
                },
                after: {
                  isActive: false,
                },
              },
            });
          });

          return {
            status: 200,
            body: {
              requestId: context.requestId,
              success: true,
            },
          };
        }
      );
      return;
    }

    json(response, 404, {
      code: "NOT_FOUND",
      message: "Route not found",
    });
  };
};

export const createApiServer = (
  prismaClient: PrismaClient,
  securityConfig: ApiSecurityConfig
): Server => {
  const requestHandler = createApiRequestHandler(prismaClient, securityConfig);
  return createServer((request, response) => {
    void requestHandler(request, response);
  });
};
