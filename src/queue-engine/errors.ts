export class QueueEngineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "TICKET_NOT_FOUND"
      | "SERVICE_NOT_FOUND"
      | "INVALID_TRANSITION"
      | "NO_WAITING_TICKETS"
      | "DUPLICATE_ACTIVE_TICKET"
      | "PRIORITY_CHANGE_NOT_ALLOWED"
      | "SERVICE_MISMATCH"
  ) {
    super(message);
    this.name = "QueueEngineError";
  }
}
