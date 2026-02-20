import { Prisma, PrismaClient, TicketStatus } from "@prisma/client";
import {
  QueueEngineRepository,
  TransferDestinationInput,
} from "./service";
import { ACTIVE_QUEUE_STATUSES, QueueEventRecord, QueueTicket } from "./types";

const mapTicketStatus = (status: TicketStatus): QueueTicket["status"] => {
  return status;
};

const toQueueTicket = (row: {
  id: string;
  hospitalId: string;
  departmentId: string;
  serviceId: string;
  ticketDate: Date;
  sequenceNumber: number;
  ticketNumber: string;
  phoneNumber: string;
  priorityCategoryId: string;
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
  priorityWeight: number;
}): QueueTicket => {
  return {
    id: row.id,
    hospitalId: row.hospitalId,
    departmentId: row.departmentId,
    serviceId: row.serviceId,
    ticketDate: row.ticketDate,
    sequenceNumber: row.sequenceNumber,
    ticketNumber: row.ticketNumber,
    phoneNumber: row.phoneNumber,
    priorityCategoryId: row.priorityCategoryId,
    priorityWeight: row.priorityWeight,
    status: mapTicketStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    calledAt: row.calledAt,
    servingStartedAt: row.servingStartedAt,
    completedAt: row.completedAt,
    noShowAt: row.noShowAt,
    cancelledAt: row.cancelledAt,
    calledCounterStationId: row.calledCounterStationId,
    originTicketId: row.originTicketId,
  };
};

type TransactionClient = Prisma.TransactionClient;

export class PrismaQueueEngineRepository implements QueueEngineRepository {
  private transactionClient: TransactionClient | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const previousClient = this.transactionClient;
      this.transactionClient = tx;
      try {
        return await work();
      } finally {
        this.transactionClient = previousClient;
      }
    });
  }

  async getTicketForUpdate(ticketId: string): Promise<QueueTicket | null> {
    const client = this.getClient();

    const rows = await client.$queryRaw<
      Array<{
        id: string;
        hospitalId: string;
        departmentId: string;
        serviceId: string;
        ticketDate: Date;
        sequenceNumber: number;
        ticketNumber: string;
        phoneNumber: string;
        priorityCategoryId: string;
        status: TicketStatus;
        calledAt: Date | null;
        servingStartedAt: Date | null;
        completedAt: Date | null;
        noShowAt: Date | null;
        cancelledAt: Date | null;
        calledCounterStationId: string | null;
        originTicketId: string | null;
        createdAt: Date;
        updatedAt: Date;
        priorityWeight: number;
      }>
    >`
      SELECT
        t."id",
        t."hospitalId",
        t."departmentId",
        t."serviceId",
        t."ticketDate",
        t."sequenceNumber",
        t."ticketNumber",
        t."phoneNumber",
        t."priorityCategoryId",
        t."status",
        t."calledAt",
        t."servingStartedAt",
        t."completedAt",
        t."noShowAt",
        t."cancelledAt",
        t."calledCounterStationId",
        t."originTicketId",
        t."createdAt",
        t."updatedAt",
        p."weight" AS "priorityWeight"
      FROM "Ticket" t
      INNER JOIN "PriorityCategory" p ON p."id" = t."priorityCategoryId"
      WHERE t."id" = ${ticketId}
      FOR UPDATE
    `;

    if (rows.length === 0) {
      return null;
    }

    return toQueueTicket(rows[0]);
  }

  async getWaitingTicketsForService(serviceId: string): Promise<QueueTicket[]> {
    const client = this.getClient();

    const rows = await client.ticket.findMany({
      where: {
        serviceId,
        status: "WAITING",
      },
      include: {
        priorityCategory: {
          select: {
            weight: true,
          },
        },
      },
      orderBy: [
        {
          priorityCategory: {
            weight: "desc",
          },
        },
        {
          createdAt: "asc",
        },
        {
          sequenceNumber: "asc",
        },
      ],
    });

    return rows.map((row) =>
      {
        const rowWithNoShowAt = row as typeof row & { noShowAt: Date | null };

        return toQueueTicket({
          id: row.id,
          hospitalId: row.hospitalId,
          departmentId: row.departmentId,
          serviceId: row.serviceId,
          ticketDate: row.ticketDate,
          sequenceNumber: row.sequenceNumber,
          ticketNumber: row.ticketNumber,
          phoneNumber: row.phoneNumber,
          priorityCategoryId: row.priorityCategoryId,
          status: row.status,
          calledAt: row.calledAt,
          servingStartedAt: row.servingStartedAt,
          completedAt: row.completedAt,
          noShowAt: rowWithNoShowAt.noShowAt,
          cancelledAt: row.cancelledAt,
          calledCounterStationId: row.calledCounterStationId,
          originTicketId: row.originTicketId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          priorityWeight: row.priorityCategory.weight,
        });
      }
    );
  }

  async hasActiveTicketForPhoneInService(args: {
    serviceId: string;
    phoneNumber: string;
    excludeTicketId?: string;
  }): Promise<boolean> {
    const client = this.getClient();

    const count = await client.ticket.count({
      where: {
        serviceId: args.serviceId,
        phoneNumber: args.phoneNumber,
        status: {
          in: ACTIVE_QUEUE_STATUSES,
        },
        id: args.excludeTicketId ? { not: args.excludeTicketId } : undefined,
      },
    });

    return count > 0;
  }

  async createTicket(args: {
    hospitalId: string;
    departmentId: string;
    serviceId: string;
    ticketDate: Date;
    sequenceNumber: number;
    ticketNumber: string;
    phoneNumber: string;
    priorityCategoryId: string;
    priorityWeight: number;
    now: Date;
  }): Promise<QueueTicket> {
    const client = this.getClient();

    const created = await client.ticket.create({
      data: {
        hospitalId: args.hospitalId,
        departmentId: args.departmentId,
        serviceId: args.serviceId,
        ticketDate: args.ticketDate,
        sequenceNumber: args.sequenceNumber,
        ticketNumber: args.ticketNumber,
        phoneNumber: args.phoneNumber,
        priorityCategoryId: args.priorityCategoryId,
        status: "WAITING",
        createdAt: args.now,
        updatedAt: args.now,
      },
      include: {
        priorityCategory: {
          select: {
            weight: true,
          },
        },
      },
    });

    const createdWithNoShowAt = created as typeof created & {
      noShowAt: Date | null;
    };

    return toQueueTicket({
      id: created.id,
      hospitalId: created.hospitalId,
      departmentId: created.departmentId,
      serviceId: created.serviceId,
      ticketDate: created.ticketDate,
      sequenceNumber: created.sequenceNumber,
      ticketNumber: created.ticketNumber,
      phoneNumber: created.phoneNumber,
      priorityCategoryId: created.priorityCategoryId,
      status: created.status,
      calledAt: created.calledAt,
      servingStartedAt: created.servingStartedAt,
      completedAt: created.completedAt,
      noShowAt: createdWithNoShowAt.noShowAt,
      cancelledAt: created.cancelledAt,
      calledCounterStationId: created.calledCounterStationId,
      originTicketId: created.originTicketId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      priorityWeight: created.priorityCategory.weight,
    });
  }

  async updateTicket(ticket: QueueTicket): Promise<QueueTicket> {
    const client = this.getClient();

    const updated = await client.ticket.update({
      where: {
        id: ticket.id,
      },
      data: {
        status: ticket.status,
        calledAt: ticket.calledAt,
        servingStartedAt: ticket.servingStartedAt,
        completedAt: ticket.completedAt,
        cancelledAt: ticket.cancelledAt,
        calledCounterStationId: ticket.calledCounterStationId,
        originTicketId: ticket.originTicketId,
        updatedAt: ticket.updatedAt,
      },
      include: {
        priorityCategory: {
          select: {
            weight: true,
          },
        },
      },
    });

    const updatedWithNoShowAt = updated as typeof updated & {
      noShowAt: Date | null;
    };

    return toQueueTicket({
      id: updated.id,
      hospitalId: updated.hospitalId,
      departmentId: updated.departmentId,
      serviceId: updated.serviceId,
      ticketDate: updated.ticketDate,
      sequenceNumber: updated.sequenceNumber,
      ticketNumber: updated.ticketNumber,
      phoneNumber: updated.phoneNumber,
      priorityCategoryId: updated.priorityCategoryId,
      status: updated.status,
      calledAt: updated.calledAt,
      servingStartedAt: updated.servingStartedAt,
      completedAt: updated.completedAt,
      noShowAt: updatedWithNoShowAt.noShowAt,
      cancelledAt: updated.cancelledAt,
      calledCounterStationId: updated.calledCounterStationId,
      originTicketId: updated.originTicketId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      priorityWeight: ticket.priorityWeight,
    });
  }

  async createTransferInTicket(args: {
    sourceTicket: QueueTicket;
    destination: TransferDestinationInput;
  }): Promise<QueueTicket> {
    const client = this.getClient();

    const created = await client.ticket.create({
      data: {
        hospitalId: args.sourceTicket.hospitalId,
        departmentId: args.destination.departmentId,
        serviceId: args.destination.serviceId,
        ticketDate: args.destination.ticketDate,
        sequenceNumber: args.destination.sequenceNumber,
        ticketNumber: args.destination.ticketNumber,
        phoneNumber: args.sourceTicket.phoneNumber,
        priorityCategoryId: args.sourceTicket.priorityCategoryId,
        status: "WAITING",
        originTicketId: args.sourceTicket.id,
      },
      include: {
        priorityCategory: {
          select: {
            weight: true,
          },
        },
      },
    });

    const createdWithNoShowAt = created as typeof created & {
      noShowAt: Date | null;
    };

    return toQueueTicket({
      id: created.id,
      hospitalId: created.hospitalId,
      departmentId: created.departmentId,
      serviceId: created.serviceId,
      ticketDate: created.ticketDate,
      sequenceNumber: created.sequenceNumber,
      ticketNumber: created.ticketNumber,
      phoneNumber: created.phoneNumber,
      priorityCategoryId: created.priorityCategoryId,
      status: created.status,
      calledAt: created.calledAt,
      servingStartedAt: created.servingStartedAt,
      completedAt: created.completedAt,
      noShowAt: createdWithNoShowAt.noShowAt,
      cancelledAt: created.cancelledAt,
      calledCounterStationId: created.calledCounterStationId,
      originTicketId: created.originTicketId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      priorityWeight: created.priorityCategory.weight,
    });
  }

  async updateTicketPriority(args: {
    ticketId: string;
    priorityCategoryId: string;
    priorityWeight: number;
    updatedAt: Date;
  }): Promise<void> {
    const client = this.getClient();

    await client.ticket.update({
      where: {
        id: args.ticketId,
      },
      data: {
        priorityCategoryId: args.priorityCategoryId,
        updatedAt: args.updatedAt,
      },
    });
  }

  async insertEvent(event: QueueEventRecord): Promise<void> {
    const client = this.getClient();

    await client.ticketEvent.create({
      data: {
        ticketId: event.ticketId,
        eventType: event.eventType,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        stationId: event.stationId,
        payload: event.payload as Prisma.InputJsonValue | undefined,
        occurredAt: event.occurredAt,
      },
    });
  }

  private getClient(): PrismaClient | TransactionClient {
    return this.transactionClient ?? this.prisma;
  }
}
