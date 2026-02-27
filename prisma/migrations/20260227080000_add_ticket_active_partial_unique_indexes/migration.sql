-- NOTE: Superseded by migration
-- 20260227090000_consolidate_ticket_active_unique_index, which drops these three
-- per-status indexes and replaces them with a single partial unique index covering
-- all active statuses at once.
-- This file is kept as-is because it was already applied; the replacement
-- migration handles the corrective DROP + CREATE.

-- Enforce the "one active ticket per phone number per service" invariant at the
-- database level. Originally three per-status partial unique indexes were created
-- here; they were consolidated in a follow-up migration.

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_waiting_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'WAITING';

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_called_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'CALLED';

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_serving_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'SERVING';
