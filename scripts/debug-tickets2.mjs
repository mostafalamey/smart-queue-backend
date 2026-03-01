import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const serviceId = "svc-seed-general-clinic";
const ticketDate = new Date("2026-03-01T00:00:00.000Z");

// Check what MAX returns for this service+date
const rows = await p.$queryRaw`
  SELECT COALESCE(MAX("sequenceNumber"), 0) AS "maxSequenceNumber"
  FROM "Ticket"
  WHERE "serviceId" = ${serviceId}
    AND "ticketDate" = ${ticketDate}
`;
console.log("MAX query result:", JSON.stringify(rows));

// Also check all tickets today (show phoneNumber too)
const tickets = await p.ticket.findMany({
  where: { ticketDate },
  select: { serviceId: true, ticketDate: true, sequenceNumber: true, status: true, phoneNumber: true },
  orderBy: { sequenceNumber: "asc" },
});
console.log("All tickets today:", JSON.stringify(tickets, null, 2));

// Check all services
const services = await p.service.findMany({
  select: { id: true, name: true, ticketPrefix: true },
});
console.log("Services:", JSON.stringify(services, null, 2));

await p.$disconnect();
