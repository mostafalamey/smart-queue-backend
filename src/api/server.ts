/// <reference path="../types/node-shim.d.ts" />
/// <reference path="../types/crypto-shim.d.ts" />

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppRole, PrismaClient, TemplateChannel } from "@prisma/client";
import { createTellerApiHandlers } from "./teller";
import { HttpResponse } from "./http";
import { QueueActor } from "../queue-engine";
import {
  AuthenticatedPrincipal,
  AuthTokenError,
  LoginError,
  RefreshError,
  loginWithPassword,
  logoutWithRefreshTokenSkeleton,
  refreshAuthTokens,
  verifyAccessToken,
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
}

interface ParsedChangePriorityPayload extends ParsedTicketActionPayload {
  priorityCategoryId: string;
  priorityWeight: number;
}

interface ParsedLoginPayload {
  email: string;
  password: string;
  stationId?: string;
  requestedRole?: AppRole;
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
  const realtimeBroadcaster =
    options?.realtimeBroadcaster ?? new NoopQueueRealtimeBroadcaster();

  const nodeEnv = (process.env.NODE_ENV ?? "").toLowerCase();
  const corsAllowedOrigins =
    options?.corsAllowedOrigins ??
    (process.env.CORS_ALLOWED_ORIGINS
      ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
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
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "GET" && path === "/health") {
      json(response, 200, {
        status: "ok",
      });
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

          // 3. Issue ticket atomically
          type CreatedTicket = {
            id: string;
            ticketNumber: string;
            serviceId: string;
            departmentId: string;
            phoneNumber: string;
            createdAt: Date;
          };

          let ticket: CreatedTicket;
          try {
            ticket = await prismaClient.$transaction(async (tx) => {
              // Duplicate active ticket guard
              const existing = await tx.ticket.findFirst({
                where: {
                  serviceId: payload.serviceId,
                  phoneNumber: payload.phoneNumber,
                  status: { in: ["WAITING", "CALLED", "SERVING"] },
                },
                select: { id: true, ticketNumber: true },
              });

              if (existing) {
                const err = new Error("Duplicate active ticket");
                (err as NodeJS.ErrnoException).code = "DUPLICATE_ACTIVE_TICKET";
                throw err;
              }

              // Next sequence number within this service+date bucket
              const maxResult = await tx.ticket.aggregate({
                where: { serviceId: payload.serviceId, ticketDate },
                _max: { sequenceNumber: true },
              });
              const sequenceNumber = (maxResult._max.sequenceNumber ?? 0) + 1;
              const ticketNumber = `${service.ticketPrefix}-${String(sequenceNumber).padStart(3, "0")}`;
              const now = new Date();

              const created = await tx.ticket.create({
                data: {
                  hospitalId: hospital.id,
                  departmentId: payload.departmentId,
                  serviceId: payload.serviceId,
                  ticketDate,
                  sequenceNumber,
                  ticketNumber,
                  phoneNumber: payload.phoneNumber,
                  priorityCategoryId: defaultPriority.id,
                  status: "WAITING",
                  createdAt: now,
                  updatedAt: now,
                },
                select: {
                  id: true,
                  ticketNumber: true,
                  serviceId: true,
                  departmentId: true,
                  phoneNumber: true,
                  createdAt: true,
                },
              });

              await tx.ticketEvent.create({
                data: {
                  ticketId: created.id,
                  eventType: "CREATED",
                  actorType: "KIOSK",
                  occurredAt: now,
                },
              });

              return created;
            });
          } catch (error: unknown) {
            const code =
              (error as NodeJS.ErrnoException).code ||
              (error as { code?: string }).code;
            if (code === "DUPLICATE_ACTIVE_TICKET") {
              return {
                status: 409,
                body: {
                  code: "DUPLICATE_ACTIVE_TICKET",
                  message: "An active ticket already exists for this phone number in this service",
                },
              };
            }
            throw error;
          }

          // 4. Queue snapshot — tickets ahead with equal or higher priority weight
          const peopleAhead = await prismaClient.ticket.count({
            where: {
              serviceId: payload.serviceId,
              ticketDate,
              status: { in: ["WAITING", "CALLED"] },
              id: { not: ticket.id },
              priorityCategory: { weight: { gte: defaultPriority.weight } },
            },
          });

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
          const result = await tellerHandlers.transfer({
            ticketId: payload.ticketId,
            destination: payload.destination,
            actor,
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
