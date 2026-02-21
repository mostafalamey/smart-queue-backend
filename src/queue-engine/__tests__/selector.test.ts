import { compareByPriorityThenFifo, selectNextWaitingTicket } from "../selector";
import { QueueTicket } from "../types";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const deepEqual = (actual: unknown, expected: unknown, message?: string): void => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${expectedJson} but got ${actualJson}`);
  }
};

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[selector] ${name} failed: ${reason}`);
  }
};

const baseTime = new Date("2026-02-21T08:00:00.000Z");

const createWaitingTicket = (overrides: Partial<QueueTicket>): QueueTicket => {
  return {
    id: overrides.id ?? "ticket-id",
    hospitalId: overrides.hospitalId ?? "hospital-1",
    departmentId: overrides.departmentId ?? "department-1",
    serviceId: overrides.serviceId ?? "service-1",
    ticketDate: overrides.ticketDate ?? new Date("2026-02-21T00:00:00.000Z"),
    sequenceNumber: overrides.sequenceNumber ?? 1,
    ticketNumber: overrides.ticketNumber ?? "A001",
    phoneNumber: overrides.phoneNumber ?? "+966500000001",
    priorityCategoryId: overrides.priorityCategoryId ?? "normal",
    priorityWeight: overrides.priorityWeight ?? 1,
    status: "WAITING",
    createdAt: overrides.createdAt ?? baseTime,
    updatedAt: overrides.updatedAt ?? baseTime,
    calledAt: null,
    servingStartedAt: null,
    completedAt: null,
    noShowAt: null,
    cancelledAt: null,
    calledCounterStationId: null,
    originTicketId: null,
  };
};

runTest("compareByPriorityThenFifo prioritizes higher priority weight", () => {
  const normal = createWaitingTicket({
    id: "normal",
    priorityWeight: 1,
    createdAt: new Date("2026-02-21T08:00:00.000Z"),
    sequenceNumber: 1,
  });

  const vip = createWaitingTicket({
    id: "vip",
    priorityWeight: 2,
    createdAt: new Date("2026-02-21T08:05:00.000Z"),
    sequenceNumber: 5,
  });

  const sorted = [normal, vip].sort(compareByPriorityThenFifo);

  equal(sorted[0].id, "vip");
  equal(sorted[1].id, "normal");
});

runTest("compareByPriorityThenFifo applies FIFO within same priority", () => {
  const earlier = createWaitingTicket({
    id: "earlier",
    priorityWeight: 1,
    createdAt: new Date("2026-02-21T08:00:00.000Z"),
    sequenceNumber: 2,
  });

  const later = createWaitingTicket({
    id: "later",
    priorityWeight: 1,
    createdAt: new Date("2026-02-21T08:01:00.000Z"),
    sequenceNumber: 1,
  });

  const sorted = [later, earlier].sort(compareByPriorityThenFifo);

  equal(sorted[0].id, "earlier");
  equal(sorted[1].id, "later");
});

runTest("compareByPriorityThenFifo uses sequence number when createdAt ties", () => {
  const firstInSequence = createWaitingTicket({
    id: "first-sequence",
    createdAt: new Date("2026-02-21T08:00:00.000Z"),
    sequenceNumber: 3,
  });

  const secondInSequence = createWaitingTicket({
    id: "second-sequence",
    createdAt: new Date("2026-02-21T08:00:00.000Z"),
    sequenceNumber: 4,
  });

  const sorted = [secondInSequence, firstInSequence].sort(compareByPriorityThenFifo);

  equal(sorted[0].id, "first-sequence");
  equal(sorted[1].id, "second-sequence");
});

runTest("selectNextWaitingTicket returns top candidate and full sorted list", () => {
  const normal = createWaitingTicket({
    id: "normal",
    priorityWeight: 1,
    createdAt: new Date("2026-02-21T08:00:00.000Z"),
  });

  const emergency = createWaitingTicket({
    id: "emergency",
    priorityWeight: 3,
    createdAt: new Date("2026-02-21T08:30:00.000Z"),
  });

  const vip = createWaitingTicket({
    id: "vip",
    priorityWeight: 2,
    createdAt: new Date("2026-02-21T08:10:00.000Z"),
  });

  const selection = selectNextWaitingTicket([normal, emergency, vip]);

  equal(selection.selected?.id, "emergency");
  deepEqual(selection.candidates.map((ticket) => ticket.id), [
    "emergency",
    "vip",
    "normal",
  ]);
});

runTest("selectNextWaitingTicket returns null selected for empty waiting list", () => {
  const selection = selectNextWaitingTicket([]);

  equal(selection.selected, null);
  deepEqual(selection.candidates, []);
});
