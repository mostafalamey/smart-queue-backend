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
- Add Prisma-backed repository adapter implementing `QueueEngineRepository`.
- Wire service methods to API endpoints (`/teller/*`, `/queue/*`).
- Add concurrency-safe transaction semantics (`SELECT ... FOR UPDATE` equivalent via Prisma tx strategy).
- Add focused tests for selector and transition matrix.
