import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createTellerApiHandlers } from "./teller";
import { HttpResponse } from "./http";

type JsonRecord = Record<string, unknown>;

type RouteHandler = (payload: JsonRecord) => Promise<HttpResponse>;

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

const readJsonBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: string[] = [];

  for await (const chunk of request) {
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

const withPayload = async (
  request: IncomingMessage,
  response: ServerResponse,
  handler: RouteHandler
): Promise<void> => {
  try {
    const payload = await readJsonBody(request);
    const result = await handler(payload);
    json(response, result.status, result.body);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      invalidRequest(response, "Invalid JSON payload");
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected request error";
    invalidRequest(response, message);
  }
};

const normalizeTransferPayload = (payload: JsonRecord): JsonRecord => {
  const destination = asRecord(payload.destination);
  if (!destination) {
    throw new Error("destination is required");
  }

  const ticketDateRaw = destination.ticketDate;
  if (typeof ticketDateRaw !== "string") {
    throw new Error("destination.ticketDate must be an ISO date string");
  }

  const ticketDate = new Date(ticketDateRaw);
  if (Number.isNaN(ticketDate.getTime())) {
    throw new Error("destination.ticketDate must be a valid ISO date string");
  }

  return {
    ...payload,
    destination: {
      ...destination,
      ticketDate,
    },
  };
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
      await withPayload(request, response, (payload) =>
        tellerHandlers.callNext(payload as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/recall") {
      await withPayload(request, response, (payload) =>
        tellerHandlers.recall(payload as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/start-serving") {
      await withPayload(request, response, (payload) =>
        tellerHandlers.startServing(payload as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/skip-no-show") {
      await withPayload(request, response, (payload) =>
        tellerHandlers.skipNoShow(payload as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/complete") {
      await withPayload(request, response, (payload) =>
        tellerHandlers.complete(payload as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/transfer") {
      await withPayload(request, response, async (payload) =>
        tellerHandlers.transfer(normalizeTransferPayload(payload) as never)
      );
      return;
    }

    if (method === "POST" && path === "/teller/change-priority") {
      await withPayload(request, response, (payload) =>
        tellerHandlers.changePriority(payload as never)
      );
      return;
    }

    json(response, 404, {
      code: "NOT_FOUND",
      message: "Route not found",
    });
  });
};
