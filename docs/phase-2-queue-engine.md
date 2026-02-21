# Smart Queue Backend — Phase 2 Start (Queue Engine Core)

Date: 2026-02-20
Branch: `feature/queue-engine-core`

## Implemented in this start
- Queue domain types and lifecycle status/event definitions.
- Deterministic queue selection (`priority desc`, then `FIFO`).
- State transition guard functions for:
  - call
  - start serving
  - skip/no-show
  - complete
  - cancel
  - transfer out
- Transaction-oriented queue engine service contract and orchestration methods.
- Duplicate active ticket guard (`phoneNumber + serviceId`).

## Current behavior decisions
- `CALLED -> SERVING` is explicit (`startServing` action), not automatic.
- `recall` does not change status; emits `RECALLED`.
- `skipNoShow` is terminal and emits `NO_SHOW`.
- `transfer` marks source `TRANSFERRED_OUT` and creates a destination `WAITING` ticket with linked transfer events.

## Next implementation slice
- Wire queue service methods to concrete HTTP routes in framework layer (`Nest/Express`) for `/teller/*`.
- Add focused tests for selector and transition matrix.
- Add integration tests for transaction safety (`callNext`, duplicate prevention).
- Add migration + repository support for any new queue fields introduced during phase 2.

## Phase 2 Progress Update (Current)
- Prisma-backed repository adapter added: `src/queue-engine/prisma-repository.ts`
- Transaction context propagation implemented via repository-level transaction client context.
- `getTicketForUpdate` now uses SQL row-level lock (`FOR UPDATE`) inside transactions.
- Queue engine service factory added: `src/queue-engine/factory.ts`
- Framework-agnostic teller API handlers added: `src/api/teller/handlers.ts`
- Repository ticket updates now persist `noShowAt` for `NO_SHOW` transitions.
- Focused selector and transition tests added under `src/queue-engine/__tests__/*`.
- Single-command runner added: `./scripts/run-queue-engine-tests.ps1`.
