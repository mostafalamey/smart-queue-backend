import { QueueSelection, QueueTicket } from "./types";

export const compareByPriorityThenFifo = (
  left: QueueTicket,
  right: QueueTicket
): number => {
  if (left.priorityWeight !== right.priorityWeight) {
    return right.priorityWeight - left.priorityWeight;
  }

  if (left.createdAt.getTime() !== right.createdAt.getTime()) {
    return left.createdAt.getTime() - right.createdAt.getTime();
  }

  return left.sequenceNumber - right.sequenceNumber;
};

export const selectNextWaitingTicket = (
  waitingTickets: QueueTicket[]
): QueueSelection => {
  const candidates = [...waitingTickets].sort(compareByPriorityThenFifo);
  const selected = candidates.length > 0 ? candidates[0] : null;

  return {
    selected,
    candidates,
  };
};
