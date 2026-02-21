# Smart Queue Backend — Phase 3 Start (Backend Core Services)

Date: 2026-02-21
Branch: `feature/backend-core-services`

## Goal
Deliver production-ready backend foundations for API runtime, auth, realtime, jobs, and PostgreSQL-backed persistence wiring.

## Current Starting Point
- Queue engine domain and transactional orchestration are already in place (`src/queue-engine/*`).
- Framework-agnostic API handler layer exists for teller operations (`src/api/teller/*`).
- Focused queue-engine tests exist and run via `./scripts/run-queue-engine-tests.ps1`.

## Phase 3 Checklist
- [x] Establish backend runtime entrypoint (HTTP server bootstrap + health endpoint).
- [x] Add environment configuration contract for backend runtime (API port, DATABASE_URL, auth secrets).
- [x] Wire Prisma client lifecycle into runtime startup/shutdown.
- [x] Wire teller API handlers through concrete HTTP routes.
- [ ] Implement authentication baseline (email/password, hash verification, token issuance skeleton).
- [ ] Add RBAC middleware/guard enforcement path for protected API routes.
- [ ] Add realtime broadcasting skeleton for queue and now-serving updates.
- [ ] Add async jobs baseline (Redis + queue worker skeleton for retries/scheduled jobs).
- [ ] Define admin configuration API surface stubs (resets/templates/mapping/retention).

## Completed Slice (Current)
- Runtime bootstrap implemented in `src/main.ts`.
- Typed runtime env loading added in `src/runtime/env.ts` for:
   - `PORT`
   - `DATABASE_URL`
   - `JWT_ACCESS_TOKEN_SECRET`
   - `JWT_REFRESH_TOKEN_SECRET`
- Concrete HTTP API server added in `src/api/server.ts` with:
   - `GET /health`
   - Teller endpoints (`/teller/call-next`, `/teller/recall`, `/teller/start-serving`, `/teller/skip-no-show`, `/teller/complete`, `/teller/transfer`, `/teller/change-priority`)
- Prisma client startup/shutdown lifecycle wired into bootstrap.
- Bearer access-token verification (`HS256`) added for teller endpoints with server-side principal extraction from `Authorization` header.
- Teller RBAC checks now use token-derived principal role and block unauthorized/forbidden requests before queue actions.

## Next Slice (Immediate)
1. Implement login credential verification and token issuance skeleton.
2. Introduce shared auth middleware wrapper to reduce per-route auth repetition.
3. Add initial app-level request context for authenticated principal mapping.

## First Implementation Slice (Completed)
1. Runtime bootstrap
   - Add concrete HTTP runtime entrypoint.
   - Add `/health` endpoint.
2. Configuration contract
   - Add typed env loading/validation for runtime-critical variables.
3. Prisma wiring
   - Instantiate a shared Prisma client in runtime.
   - Graceful shutdown hooks.
4. API route integration
   - Expose teller handlers through concrete HTTP routes (without changing queue domain logic).

## Notes / Constraints
- Keep queue business logic inside `src/queue-engine/*`.
- Keep HTTP translation concerns in `src/api/*`.
- Preserve transaction and event-recording guarantees from Phase 2.
- Enforce RBAC server-side when auth middleware is introduced.
