/// <reference path="../types/node-shim.d.ts" />
/// <reference path="../types/crypto-shim.d.ts" />

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppRole, PrismaClient } from "@prisma/client";
import { createTellerApiHandlers } from "./teller";
import { HttpResponse } from "./http";
import { QueueActor } from "../queue-engine";
import {
  AuthenticatedPrincipal,
  AuthTokenError,
  LoginError,
  loginWithPassword,
  verifyAccessToken,
} from "../auth";

type JsonRecord = Record<string, unknown>;

type RouteHandler<TPayload> = (payload: TPayload) => Promise<HttpResponse>;

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
  deviceId?: string;
  stationId?: string;
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

const getHeader = (request: IncomingMessage, name: string): string | undefined => {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
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

const isAllowedTellerRole = (role: AppRole): boolean => {
  return (
    role === AppRole.ADMIN ||
    role === AppRole.IT ||
    role === AppRole.MANAGER ||
    role === AppRole.STAFF
  );
};

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

const getAuthorizedTellerActor = (
  request: IncomingMessage,
  jwtAccessTokenSecret: string
): QueueActor => {
  const principal = getAuthenticatedPrincipal(request, jwtAccessTokenSecret);

  if (!isAllowedTellerRole(principal.role)) {
    throw new ForbiddenError("Authenticated role is not allowed for teller actions");
  }

  return {
    actorType: "USER",
    actorUserId: principal.userId,
    stationId: principal.stationId,
  };
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
    deviceId: optionalString(payload, "deviceId"),
    stationId: optionalString(payload, "stationId"),
  };
};

const withPayload = async <TPayload>(
  request: IncomingMessage,
  response: ServerResponse,
  parse: (payload: JsonRecord) => TPayload,
  handler: RouteHandler<TPayload>
): Promise<void> => {
  try {
    const payload = await readJsonBody(request);
    const parsedPayload = parse(payload);
    const result = await handler(parsedPayload);
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

    internalServerError(response);
  }
};

const withAuthorizedTellerPayload = async <TPayload>(
  request: IncomingMessage,
  response: ServerResponse,
  parse: (payload: JsonRecord) => TPayload,
  jwtAccessTokenSecret: string,
  handler: (payload: TPayload, actor: QueueActor) => Promise<HttpResponse>
): Promise<void> => {
  await withPayload(request, response, parse, (payload) => {
    const actor = getAuthorizedTellerActor(request, jwtAccessTokenSecret);
    return handler(payload, actor);
  });
};

export interface ApiSecurityConfig {
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
}

export const createApiServer = (
  prismaClient: PrismaClient,
  securityConfig: ApiSecurityConfig
): Server => {
  const tellerHandlers = createTellerApiHandlers(prismaClient);

  return createServer(async (request, response) => {
    const method = request.method ?? "";
    const path = request.url?.split("?")[0] ?? "";

    if (method === "GET" && path === "/health") {
      json(response, 200, {
        status: "ok",
      });
      return;
    }

    if (method === "POST" && path === "/auth/login") {
      await withPayload(request, response, parseLoginPayload, async (payload) => {
        const result = await loginWithPassword(prismaClient, payload, {
          jwtAccessTokenSecret: securityConfig.jwtAccessTokenSecret,
          jwtRefreshTokenSecret: securityConfig.jwtRefreshTokenSecret,
        });

        return {
          status: 200,
          body: result,
        };
      });
      return;
    }

    if (method === "POST" && path === "/teller/call-next") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseCallNextPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.callNext({
            serviceId: payload.serviceId,
            stationId: requireStationId(actor),
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/recall") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.recall({
            ticketId: payload.ticketId,
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/start-serving") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.startServing({
            ticketId: payload.ticketId,
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/skip-no-show") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.skipNoShow({
            ticketId: payload.ticketId,
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/complete") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseTicketActionPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.complete({
            ticketId: payload.ticketId,
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/transfer") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseTransferPayload,
        securityConfig.jwtAccessTokenSecret,
        async (payload, actor) => {
          return tellerHandlers.transfer({
            ticketId: payload.ticketId,
            destination: payload.destination,
            actor,
          });
        }
      );
      return;
    }

    if (method === "POST" && path === "/teller/change-priority") {
      await withAuthorizedTellerPayload(
        request,
        response,
        parseChangePriorityPayload,
        securityConfig.jwtAccessTokenSecret,
        (payload, actor) => {
          return tellerHandlers.changePriority({
            ticketId: payload.ticketId,
            priorityCategoryId: payload.priorityCategoryId,
            priorityWeight: payload.priorityWeight,
            actor,
          });
        }
      );
      return;
    }

    json(response, 404, {
      code: "NOT_FOUND",
      message: "Route not found",
    });
  });
};
