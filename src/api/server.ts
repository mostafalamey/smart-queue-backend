import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createTellerApiHandlers } from "./teller";
import { HttpResponse } from "./http";
import {
  CallNextRequest,
  ChangePriorityRequest,
  TicketActionRequest,
  TransferTicketRequest,
} from "./teller";
import { ActorType, QueueActor } from "../queue-engine";

type JsonRecord = Record<string, unknown>;

type RouteHandler<TPayload> = (payload: TPayload) => Promise<HttpResponse>;

const MAX_JSON_BODY_BYTES = 1024 * 1024;

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

const actorTypes: ActorType[] = [
  "USER",
  "SYSTEM",
  "PATIENT_WHATSAPP",
  "PATIENT_PWA",
  "KIOSK",
];

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
    throw new Error("Request body must be a JSON object");
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

const parseActor = (payload: JsonRecord): QueueActor => {
  const actorPayload = asRecord(payload.actor);
  if (!actorPayload) {
    throw new RequestValidationError("actor is required");
  }

  const actorType = requireString(actorPayload, "actorType");
  if (!actorTypes.includes(actorType as ActorType)) {
    throw new RequestValidationError(
      `actor.actorType must be one of: ${actorTypes.join(", ")}`
    );
  }

  const actorUserIdValue = actorPayload.actorUserId;
  if (
    actorUserIdValue !== undefined &&
    (typeof actorUserIdValue !== "string" || actorUserIdValue.trim().length === 0)
  ) {
    throw new RequestValidationError(
      "actor.actorUserId must be a non-empty string when provided"
    );
  }

  const stationIdValue = actorPayload.stationId;
  if (
    stationIdValue !== undefined &&
    (typeof stationIdValue !== "string" || stationIdValue.trim().length === 0)
  ) {
    throw new RequestValidationError(
      "actor.stationId must be a non-empty string when provided"
    );
  }

  return {
    actorType: actorType as ActorType,
    actorUserId:
      typeof actorUserIdValue === "string" ? actorUserIdValue : undefined,
    stationId: typeof stationIdValue === "string" ? stationIdValue : undefined,
  };
};

const parseCallNextRequest = (payload: JsonRecord): CallNextRequest => {
  return {
    serviceId: requireString(payload, "serviceId"),
    stationId: requireString(payload, "stationId"),
    actor: parseActor(payload),
  };
};

const parseTicketActionRequest = (payload: JsonRecord): TicketActionRequest => {
  return {
    ticketId: requireString(payload, "ticketId"),
    actor: parseActor(payload),
  };
};

const parseTransferTicketRequest = (
  payload: JsonRecord
): TransferTicketRequest => {
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
    actor: parseActor(payload),
    destination: {
      departmentId: requireString(destinationPayload, "departmentId"),
      serviceId: requireString(destinationPayload, "serviceId"),
      ticketDate,
    },
  };
};

const parseChangePriorityRequest = (
  payload: JsonRecord
): ChangePriorityRequest => {
  const priorityWeight = requireNumber(payload, "priorityWeight");

  return {
    ticketId: requireString(payload, "ticketId"),
    actor: parseActor(payload),
    priorityCategoryId: requireString(payload, "priorityCategoryId"),
    priorityWeight,
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

    if (error instanceof SyntaxError || error instanceof RequestValidationError) {
      const message =
        error instanceof SyntaxError ? "Invalid JSON payload" : error.message;
      invalidRequest(response, message);
      return;
    }

    internalServerError(response);
  }
};

export const createApiServer = (prismaClient: PrismaClient): Server => {
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

    if (method === "POST" && path === "/teller/call-next") {
      await withPayload(request, response, parseCallNextRequest, (payload) =>
        tellerHandlers.callNext(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/recall") {
      await withPayload(request, response, parseTicketActionRequest, (payload) =>
        tellerHandlers.recall(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/start-serving") {
      await withPayload(request, response, parseTicketActionRequest, (payload) =>
        tellerHandlers.startServing(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/skip-no-show") {
      await withPayload(request, response, parseTicketActionRequest, (payload) =>
        tellerHandlers.skipNoShow(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/complete") {
      await withPayload(request, response, parseTicketActionRequest, (payload) =>
        tellerHandlers.complete(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/transfer") {
      await withPayload(
        request,
        response,
        parseTransferTicketRequest,
        async (payload) => tellerHandlers.transfer(payload)
      );
      return;
    }

    if (method === "POST" && path === "/teller/change-priority") {
      await withPayload(request, response, parseChangePriorityRequest, (payload) =>
        tellerHandlers.changePriority(payload)
      );
      return;
    }

    json(response, 404, {
      code: "NOT_FOUND",
      message: "Route not found",
    });
  });
};
