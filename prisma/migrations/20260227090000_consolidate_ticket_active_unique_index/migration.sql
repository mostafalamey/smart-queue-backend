-- Replace the three per-status partial unique indexes created in
-- 20260227080000_add_ticket_active_partial_unique_indexes with a single
-- partial unique index that covers all active statuses in one predicate.
--
-- The three separate indexes were logically flawed: each only prevented
-- two rows with the *same* status, so a WAITING row and a CALLED row for
-- the same (serviceId, phoneNumber) pair could coexist, violating the
-- "one active ticket per phone per service" invariant.
--
-- A single index with WHERE status IN ('WAITING','CALLED','SERVING') treats
-- the three statuses as one domain and correctly blocks any second active row
-- regardless of which status it carries.
--
-- PostgreSQL fully supports IN conditions in partial index predicates.

DROP INDEX IF EXISTS "Ticket_serviceId_phoneNumber_waiting_key";
DROP INDEX IF EXISTS "Ticket_serviceId_phoneNumber_called_key";
DROP INDEX IF EXISTS "Ticket_serviceId_phoneNumber_serving_key";

CREATE UNIQUE INDEX "Ticket_serviceId_phoneNumber_active_key"
  ON "Ticket"("serviceId", "phoneNumber")
  WHERE status IN ('WAITING', 'CALLED', 'SERVING');
