import { QueueEngineError } from "./errors";
import { QueueTicket, TicketStatus } from "./types";

const allowedTransitions: Record<TicketStatus, TicketStatus[]> = {
  WAITING: ["CALLED", "CANCELLED", "TRANSFERRED_OUT"],
  CALLED: ["SERVING", "NO_SHOW", "TRANSFERRED_OUT"],
  SERVING: ["COMPLETED", "NO_SHOW", "TRANSFERRED_OUT"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
  TRANSFERRED_OUT: [],
};

export const assertTransition = (
  currentStatus: TicketStatus,
  nextStatus: TicketStatus
): void => {
  const allowed = allowedTransitions[currentStatus] ?? [];

  if (!allowed.includes(nextStatus)) {
    throw new QueueEngineError(
      `Invalid ticket transition from ${currentStatus} to ${nextStatus}`,
      "INVALID_TRANSITION"
    );
  }
};

export const markCalled = (
  ticket: QueueTicket,
  stationId: string,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "CALLED");

  return {
    ...ticket,
    status: "CALLED",
    calledAt: timestamp,
    calledCounterStationId: stationId,
    updatedAt: timestamp,
  };
};

export const startServing = (
  ticket: QueueTicket,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "SERVING");

  return {
    ...ticket,
    status: "SERVING",
    servingStartedAt: timestamp,
    updatedAt: timestamp,
  };
};

export const markNoShow = (
  ticket: QueueTicket,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "NO_SHOW");

  return {
    ...ticket,
    status: "NO_SHOW",
    noShowAt: timestamp,
    updatedAt: timestamp,
  };
};

export const markCompleted = (
  ticket: QueueTicket,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "COMPLETED");

  return {
    ...ticket,
    status: "COMPLETED",
    completedAt: timestamp,
    updatedAt: timestamp,
  };
};

export const markCancelled = (
  ticket: QueueTicket,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "CANCELLED");

  return {
    ...ticket,
    status: "CANCELLED",
    cancelledAt: timestamp,
    updatedAt: timestamp,
  };
};

export const markTransferredOut = (
  ticket: QueueTicket,
  timestamp: Date
): QueueTicket => {
  assertTransition(ticket.status, "TRANSFERRED_OUT");

  return {
    ...ticket,
    status: "TRANSFERRED_OUT",
    updatedAt: timestamp,
  };
};

export const canChangePriority = (ticket: QueueTicket): boolean => {
  return ticket.status === "WAITING";
};
