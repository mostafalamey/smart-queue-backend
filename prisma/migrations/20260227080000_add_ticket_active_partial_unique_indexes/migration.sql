-- Enforce the "one active ticket per phone number per service" invariant at the
-- database level using three partial unique indexes (one per active status value).
--
-- PostgreSQL does not support a partial unique index with an IN condition, so
-- three separate indexes are required — one for each active TicketStatus value.
--
-- Together they make it structurally impossible for two rows with the same
-- (serviceId, phoneNumber) to exist in any active status, regardless of how
-- the data is written (application, admin tools, migrations, direct SQL, etc.).
--
-- The application layer adds pg_advisory_xact_lock as a first line of defence
-- to prevent the duplicate before hitting these indexes; these indexes are the
-- hard backstop.

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_waiting_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'WAITING';

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_called_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'CALLED';

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_serving_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status = 'SERVING';
