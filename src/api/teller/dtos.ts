import { QueueActor, TransferReasonSnapshot } from "../../queue-engine";

export interface CallNextRequest {
  serviceId: string;
  stationId: string;
  actor: QueueActor;
}

export interface TicketActionRequest {
  ticketId: string;
  actor: QueueActor;
}

export interface TransferTicketRequest extends TicketActionRequest {
  destination: {
    departmentId: string;
    serviceId: string;
    ticketDate: Date;
  };
  reason?: TransferReasonSnapshot;
}

export interface ChangePriorityRequest extends TicketActionRequest {
  priorityCategoryId: string;
  priorityWeight: number;
}
