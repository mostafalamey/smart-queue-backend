import { PrismaClient } from "@prisma/client";
import { failure, HttpResponse, ok } from "../http";
import {
  createQueueEngineService,
  QueueEngineError,
  QueueEngineService,
  QueueTicket,
} from "../../queue-engine";
import {
  CallNextRequest,
  ChangePriorityRequest,
  TicketActionRequest,
  TransferTicketRequest,
} from "./dtos";

const mapQueueError = (error: QueueEngineError): HttpResponse => {
  switch (error.code) {
    case "TICKET_NOT_FOUND":
      return failure(404, error.code, error.message);
    case "NO_WAITING_TICKETS":
      return failure(404, error.code, error.message);
    case "DUPLICATE_ACTIVE_TICKET":
      return failure(409, error.code, error.message);
    case "PRIORITY_CHANGE_NOT_ALLOWED":
      return failure(409, error.code, error.message);
    case "INVALID_TRANSITION":
      return failure(409, error.code, error.message);
    case "SERVICE_MISMATCH":
      return failure(400, error.code, error.message);
    default:
      return failure(400, "QUEUE_ENGINE_ERROR", error.message);
  }
};

const execute = async <T>(work: () => Promise<T>): Promise<HttpResponse<T>> => {
  try {
    const result = await work();
    return ok(result);
  } catch (error: unknown) {
    if (error instanceof QueueEngineError) {
      return mapQueueError(error) as HttpResponse<T>;
    }

    return failure(500, "INTERNAL_ERROR", "Unexpected server error") as HttpResponse<T>;
  }
};

export class TellerApiHandlers {
  constructor(private readonly queueEngine: QueueEngineService) {}

  async callNext(request: CallNextRequest): Promise<HttpResponse<QueueTicket>> {
    return execute(() =>
      this.queueEngine.callNext({
        serviceId: request.serviceId,
        stationId: request.stationId,
        actor: request.actor,
      })
    );
  }

  async recall(request: TicketActionRequest): Promise<HttpResponse<QueueTicket>> {
    return execute(() =>
      this.queueEngine.recall({
        ticketId: request.ticketId,
        actor: request.actor,
      })
    );
  }

  async startServing(
    request: TicketActionRequest
  ): Promise<HttpResponse<QueueTicket>> {
    return execute(() =>
      this.queueEngine.startServing({
        ticketId: request.ticketId,
        actor: request.actor,
      })
    );
  }

  async skipNoShow(
    request: TicketActionRequest
  ): Promise<HttpResponse<QueueTicket>> {
    return execute(() =>
      this.queueEngine.skipNoShow({
        ticketId: request.ticketId,
        actor: request.actor,
      })
    );
  }

  async complete(request: TicketActionRequest): Promise<HttpResponse<QueueTicket>> {
    return execute(() =>
      this.queueEngine.complete({
        ticketId: request.ticketId,
        actor: request.actor,
      })
    );
  }

  async transfer(request: TransferTicketRequest) {
    return execute(() =>
      this.queueEngine.transfer({
        ticketId: request.ticketId,
        destination: request.destination,
        actor: request.actor,
      })
    );
  }

  async changePriority(request: ChangePriorityRequest): Promise<HttpResponse<void>> {
    return execute(() =>
      this.queueEngine.changePriority({
        ticketId: request.ticketId,
        priorityCategoryId: request.priorityCategoryId,
        priorityWeight: request.priorityWeight,
        actor: request.actor,
      })
    );
  }
}

export const createTellerApiHandlers = (
  prismaClient: PrismaClient
): TellerApiHandlers => {
  const queueEngine = createQueueEngineService({
    prismaClient,
  });

  return new TellerApiHandlers(queueEngine);
};
