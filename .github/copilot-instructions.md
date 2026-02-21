# Copilot Instructions for smart-queue-backend

## Scope and boundaries
- This repository owns backend/domain behavior for Smart Queue.
- Keep queue business logic in `src/queue-engine/*`; avoid leaking framework-specific concerns into domain/service modules.
- Keep HTTP/request translation and response mapping in `src/api/*`.

## Domain invariants (must hold)
- Queue ordering is strictly **priority first, FIFO within priority**.
- Enforce one active ticket per phone number per service.
- No manual queue reordering path.
- Transfer must create a new destination sequence/ticket number (server-generated only).
- Patient cancellation is allowed only before ticket is called.

## Concurrency and persistence rules
- All queue mutations must run inside repository transactions (`runInTransaction`).
- Preserve row-locking behavior for critical selection/update paths (e.g., call-next and state transitions).
- Record every ticket lifecycle transition as a `TicketEvent`; do not bypass event persistence.

## Error and API contract rules
- Use typed domain errors in `src/queue-engine/errors.ts`.
- Map domain errors to HTTP responses in API handlers (e.g., teller handlers) without embedding HTTP concerns in queue engine code.
- Keep transfer request validation strict: destination numbering fields are server-owned and rejected from client payloads.

## Data model and schema guidance
- Prefer additive, minimal Prisma changes.
- Keep relations explicit and unambiguous in `prisma/schema.prisma`.
- Preserve constraints and indexes that enforce queue correctness and lookup performance.

## RBAC and role expectations
- Roles: Admin, IT, Manager, Staff.
- Manager scope is exactly one department.
- Enforce RBAC server-side regardless of UI visibility restrictions.

## Workflow expectations
- Use feature branches (`feature/<area>-<name>`) and PR-based merges to `main`.
- Keep changes surgical and requirement-aligned; avoid speculative behavior.
- When behavior/contracts change, update repository docs under `docs/*` (especially API/domain notes).
- If uncertain, follow the simplest behavior aligned with root product docs:
  - `../docs/smart-queue-plan.md`
  - `../docs/admin-app-spec.md`
