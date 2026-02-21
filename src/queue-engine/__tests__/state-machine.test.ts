import {
  assertTransition,
  canChangePriority,
  markCalled,
  markCancelled,
  markCompleted,
  markNoShow,
  markTransferredOut,
  startServing,
} from "../state-machine";
import { QueueEngineError } from "../errors";
import { QueueTicket, TicketStatus } from "../types";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const doesNotThrow = (fn: () => void): void => {
  fn();
};

const throws = (
  fn: () => void,
  matcher: (error: unknown) => boolean,
  message?: string
): void => {
  try {
    fn();
  } catch (error: unknown) {
    if (matcher(error)) {
      return;
    }

    throw new Error(message ?? "Function threw unexpected error");
  }

  throw new Error(message ?? "Expected function to throw");
};

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[state-machine] ${name} failed: ${reason}`);
  }
};

const statuses: TicketStatus[] = [
  "WAITING",
  "CALLED",
  "SERVING",
  "COMPLETED",
  "NO_SHOW",
  "CANCELLED",
  "TRANSFERRED_OUT",
];

const allowedTransitions: Record<TicketStatus, TicketStatus[]> = {
  WAITING: ["CALLED", "CANCELLED", "TRANSFERRED_OUT"],
  CALLED: ["SERVING", "NO_SHOW", "TRANSFERRED_OUT"],
  SERVING: ["COMPLETED", "NO_SHOW", "TRANSFERRED_OUT"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
  TRANSFERRED_OUT: [],
};

const createTicket = (status: TicketStatus): QueueTicket => ({
  id: `ticket-${status}`,
  hospitalId: "hospital-1",
  departmentId: "department-1",
  serviceId: "service-1",
  ticketDate: new Date("2026-02-21T00:00:00.000Z"),
  sequenceNumber: 1,
  ticketNumber: "A001",
  phoneNumber: "+966500000001",
  priorityCategoryId: "normal",
  priorityWeight: 1,
  status,
  createdAt: new Date("2026-02-21T08:00:00.000Z"),
  updatedAt: new Date("2026-02-21T08:00:00.000Z"),
  calledAt: null,
  servingStartedAt: null,
  completedAt: null,
  noShowAt: null,
  cancelledAt: null,
  calledCounterStationId: null,
  originTicketId: null,
});

runTest("assertTransition accepts all allowed transitions", () => {
  for (const [current, nextStatuses] of Object.entries(allowedTransitions) as Array<
    [TicketStatus, TicketStatus[]]
  >) {
    for (const next of nextStatuses) {
      doesNotThrow(() => assertTransition(current, next));
    }
  }
});

runTest("assertTransition rejects all disallowed transitions", () => {
  for (const current of statuses) {
    const allowed = new Set(allowedTransitions[current]);

    for (const next of statuses) {
      if (allowed.has(next)) {
        continue;
      }

      throws(
        () => assertTransition(current, next),
        (error: unknown) => {
          if (!(error instanceof QueueEngineError)) {
            return false;
          }

          return error.code === "INVALID_TRANSITION";
        },
        `Expected INVALID_TRANSITION for ${current} -> ${next}`
      );
    }
  }
});

runTest("markCalled updates status and call metadata", () => {
  const now = new Date("2026-02-21T08:30:00.000Z");
  const updated = markCalled(createTicket("WAITING"), "station-1", now);

  equal(updated.status, "CALLED");
  equal(updated.calledCounterStationId, "station-1");
  equal(updated.calledAt?.toISOString(), now.toISOString());
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("startServing updates status and serving timestamp", () => {
  const now = new Date("2026-02-21T08:40:00.000Z");
  const updated = startServing(createTicket("CALLED"), now);

  equal(updated.status, "SERVING");
  equal(updated.servingStartedAt?.toISOString(), now.toISOString());
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("markNoShow updates status and noShowAt timestamp", () => {
  const now = new Date("2026-02-21T08:50:00.000Z");
  const updated = markNoShow(createTicket("CALLED"), now);

  equal(updated.status, "NO_SHOW");
  equal(updated.noShowAt?.toISOString(), now.toISOString());
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("markCompleted updates status and completed timestamp", () => {
  const now = new Date("2026-02-21T09:00:00.000Z");
  const updated = markCompleted(createTicket("SERVING"), now);

  equal(updated.status, "COMPLETED");
  equal(updated.completedAt?.toISOString(), now.toISOString());
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("markCancelled updates status and cancelled timestamp", () => {
  const now = new Date("2026-02-21T09:10:00.000Z");
  const updated = markCancelled(createTicket("WAITING"), now);

  equal(updated.status, "CANCELLED");
  equal(updated.cancelledAt?.toISOString(), now.toISOString());
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("markTransferredOut updates status and updatedAt", () => {
  const now = new Date("2026-02-21T09:20:00.000Z");
  const updated = markTransferredOut(createTicket("CALLED"), now);

  equal(updated.status, "TRANSFERRED_OUT");
  equal(updated.updatedAt.toISOString(), now.toISOString());
});

runTest("canChangePriority only allows WAITING status", () => {
  equal(canChangePriority(createTicket("WAITING")), true);
  equal(canChangePriority(createTicket("CALLED")), false);
  equal(canChangePriority(createTicket("SERVING")), false);
  equal(canChangePriority(createTicket("COMPLETED")), false);
  equal(canChangePriority(createTicket("NO_SHOW")), false);
  equal(canChangePriority(createTicket("CANCELLED")), false);
  equal(canChangePriority(createTicket("TRANSFERRED_OUT")), false);
});
