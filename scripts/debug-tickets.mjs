import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const rows = await p.ticket.findMany({
  select: { id: true, serviceId: true, ticketDate: true, sequenceNumber: true, status: true, createdAt: true },
  orderBy: { createdAt: "desc" },
  take: 10,
});
console.log(JSON.stringify(rows, null, 2));

// Also check today's ticketDate bucket from the server's perspective
const today = new Date();
console.log("\nToday UTC:", today.toISOString());

// Simulate getTicketDateBucket for common timezones
for (const tz of ["Asia/Riyadh", "UTC", "Asia/Beirut"]) {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(today);
  const bucket = new Date(dateStr + "T00:00:00.000Z");
  console.log(`Bucket [${tz}]: ${bucket.toISOString()}`);
}

await p.$disconnect();
