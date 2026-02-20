import { QueueEngineError } from "./errors";
import { selectNextWaitingTicket } from "./selector";
import {
  canChangePriority,
  markCalled,
  markCancelled,
  markCompleted,
  markNoShow,
  markTransferredOut,
  startServing,
} from "./state-machine";
import {
  QueueActor,
  QueueEventRecord,
  QueueTicket,
  TransferResult,
} from "./types";

export interface TransferDestinationInput {
  departmentId: string;
  serviceId: string;
  ticketDate: Date;
  sequenceNumber: number;
  ticketNumber: string;
}

export interface QueueEngineRepository {
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
  getTicketForUpdate(ticketId: string): Promise<QueueTicket | null>;
  getWaitingTicketsForService(serviceId: string): Promise<QueueTicket[]>;
  hasActiveTicketForPhoneInService(args: {
    serviceId: string;
    phoneNumber: string;
    excludeTicketId?: string;
  }): Promise<boolean>;
  updateTicket(ticket: QueueTicket): Promise<QueueTicket>;
  createTransferInTicket(args: {
    sourceTicket: QueueTicket;
    destination: TransferDestinationInput;
  }): Promise<QueueTicket>;
  updateTicketPriority(args: {
    ticketId: string;
    priorityCategoryId: string;
    priorityWeight: number;
    updatedAt: Date;
  }): Promise<void>;
  insertEvent(event: QueueEventRecord): Promise<void>;
}

export class QueueEngineService {
  constructor(private readonly repository: QueueEngineRepository) {}

  async callNext(args: {
    serviceId: string;
    stationId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const waitingTickets = await this.repository.getWaitingTicketsForService(
        args.serviceId
      );
      const selection = selectNextWaitingTicket(waitingTickets);

      if (!selection.selected) {
        throw new QueueEngineError(
          "No waiting tickets available for this service",
          "NO_WAITING_TICKETS"
        );
      }

      const called = markCalled(selection.selected, args.stationId, timestamp);
      const updated = await this.repository.updateTicket(called);

      await this.repository.insertEvent({
        ticketId: updated.id,
        eventType: "CALLED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.stationId,
        occurredAt: timestamp,
      });

      return updated;
    });
  }

  async recall(args: {
    ticketId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);

      if (ticket.status !== "CALLED" && ticket.status !== "SERVING") {
        throw new QueueEngineError(
          "Recall is only allowed for CALLED or SERVING tickets",
          "INVALID_TRANSITION"
        );
      }

      await this.repository.insertEvent({
        ticketId: ticket.id,
        eventType: "RECALLED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
      });

      return ticket;
    });
  }

  async startServing(args: {
    ticketId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);
      const serving = startServing(ticket, timestamp);
      const updated = await this.repository.updateTicket(serving);

      await this.repository.insertEvent({
        ticketId: updated.id,
        eventType: "SERVING_STARTED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
      });

      return updated;
    });
  }

  async skipNoShow(args: {
    ticketId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);
      const noShow = markNoShow(ticket, timestamp);
      const updated = await this.repository.updateTicket(noShow);

      await this.repository.insertEvent({
        ticketId: updated.id,
        eventType: "NO_SHOW",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
      });

      return updated;
    });
  }

  async complete(args: {
    ticketId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);
      const completed = markCompleted(ticket, timestamp);
      const updated = await this.repository.updateTicket(completed);

      await this.repository.insertEvent({
        ticketId: updated.id,
        eventType: "COMPLETED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
      });

      return updated;
    });
  }

  async cancelWaiting(args: {
    ticketId: string;
    actor: QueueActor;
    now?: Date;
  }): Promise<QueueTicket> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);
      const cancelled = markCancelled(ticket, timestamp);
      const updated = await this.repository.updateTicket(cancelled);

      await this.repository.insertEvent({
        ticketId: updated.id,
        eventType: "CANCELLED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
      });

      return updated;
    });
  }

  async transfer(args: {
    ticketId: string;
    destination: TransferDestinationInput;
    actor: QueueActor;
    now?: Date;
  }): Promise<TransferResult> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const source = await this.requireTicket(args.ticketId);
      const transferredOut = markTransferredOut(source, timestamp);
      const sourceUpdated = await this.repository.updateTicket(transferredOut);

      const destinationTicket = await this.repository.createTransferInTicket({
        sourceTicket: sourceUpdated,
        destination: args.destination,
      });

      await this.repository.insertEvent({
        ticketId: sourceUpdated.id,
        eventType: "TRANSFERRED_OUT",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
        payload: {
          destinationServiceId: destinationTicket.serviceId,
          destinationTicketId: destinationTicket.id,
          destinationTicketNumber: destinationTicket.ticketNumber,
        },
      });

      await this.repository.insertEvent({
        ticketId: destinationTicket.id,
        eventType: "TRANSFERRED_IN",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
        payload: {
          sourceServiceId: sourceUpdated.serviceId,
          sourceTicketId: sourceUpdated.id,
          sourceTicketNumber: sourceUpdated.ticketNumber,
        },
      });

      return {
        sourceTicket: sourceUpdated,
        destinationTicket,
      };
    });
  }

  async changePriority(args: {
    ticketId: string;
    priorityCategoryId: string;
    priorityWeight: number;
    actor: QueueActor;
    now?: Date;
  }): Promise<void> {
    const timestamp = args.now ?? new Date();

    return this.repository.runInTransaction(async () => {
      const ticket = await this.requireTicket(args.ticketId);

      if (!canChangePriority(ticket)) {
        throw new QueueEngineError(
          "Priority can only be changed while ticket is WAITING",
          "PRIORITY_CHANGE_NOT_ALLOWED"
        );
      }

      await this.repository.updateTicketPriority({
        ticketId: ticket.id,
        priorityCategoryId: args.priorityCategoryId,
        priorityWeight: args.priorityWeight,
        updatedAt: timestamp,
      });

      await this.repository.insertEvent({
        ticketId: ticket.id,
        eventType: "PRIORITY_CHANGED",
        actorType: args.actor.actorType,
        actorUserId: args.actor.actorUserId,
        stationId: args.actor.stationId,
        occurredAt: timestamp,
        payload: {
          priorityCategoryId: args.priorityCategoryId,
          priorityWeight: args.priorityWeight,
        },
      });
    });
  }

  async assertNoDuplicateActiveTicket(args: {
    serviceId: string;
    phoneNumber: string;
    excludeTicketId?: string;
  }): Promise<void> {
    const hasDuplicate = await this.repository.hasActiveTicketForPhoneInService({
      serviceId: args.serviceId,
      phoneNumber: args.phoneNumber,
      excludeTicketId: args.excludeTicketId,
    });

    if (hasDuplicate) {
      throw new QueueEngineError(
        "Only one active ticket per phone number per service is allowed",
        "DUPLICATE_ACTIVE_TICKET"
      );
    }
  }

  private async requireTicket(ticketId: string): Promise<QueueTicket> {
    const ticket = await this.repository.getTicketForUpdate(ticketId);

    if (!ticket) {
      throw new QueueEngineError("Ticket not found", "TICKET_NOT_FOUND");
    }

    return ticket;
  }
}
