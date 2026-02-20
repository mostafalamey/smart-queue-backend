export type TicketStatus =
  | "WAITING"
  | "CALLED"
  | "SERVING"
  | "COMPLETED"
  | "NO_SHOW"
  | "CANCELLED"
  | "TRANSFERRED_OUT";

export type QueueEventType =
  | "CREATED"
  | "CALLED"
  | "RECALLED"
  | "SERVING_STARTED"
  | "COMPLETED"
  | "NO_SHOW"
  | "CANCELLED"
  | "TRANSFERRED_OUT"
  | "TRANSFERRED_IN"
  | "PRIORITY_CHANGED"
  | "LOCKED"
  | "UNLOCKED";

export type ActorType =
  | "USER"
  | "SYSTEM"
  | "PATIENT_WHATSAPP"
  | "PATIENT_PWA"
  | "KIOSK";

export interface QueueTicket {
  id: string;
  hospitalId: string;
  departmentId: string;
  serviceId: string;
  ticketDate: Date;
  sequenceNumber: number;
  ticketNumber: string;
  phoneNumber: string;
  priorityCategoryId: string;
  priorityWeight: number;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  calledAt: Date | null;
  servingStartedAt: Date | null;
  completedAt: Date | null;
  noShowAt: Date | null;
  cancelledAt: Date | null;
  calledCounterStationId: string | null;
  originTicketId: string | null;
}

export interface QueueEventRecord {
  ticketId: string;
  eventType: QueueEventType;
  actorType: ActorType;
  actorUserId?: string;
  stationId?: string;
  payload?: Record<string, unknown>;
  occurredAt: Date;
}

export interface QueueActor {
  actorType: ActorType;
  actorUserId?: string;
  stationId?: string;
}

export interface QueueSelection {
  selected: QueueTicket | null;
  candidates: QueueTicket[];
}

export interface TransferResult {
  sourceTicket: QueueTicket;
  destinationTicket: QueueTicket;
}

export const ACTIVE_QUEUE_STATUSES: TicketStatus[] = [
  "WAITING",
  "CALLED",
  "SERVING",
];
