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
- [x] Implement authentication baseline (email/password, hash verification, token issuance skeleton).
- [x] Add initial app-level request context for authenticated principal mapping.
- [x] Add `/auth/refresh` and `/auth/logout` skeleton endpoints.
- [x] Align backend runtime entrypoint with NestJS module/controller bootstrap path.
- [x] Align password hashing baseline to Argon2id (with legacy hash verification migration path).
- [x] Add backend packaging baseline (`package.json`, lockfile, env template, compose file).
- [x] Add RBAC middleware/guard enforcement path for protected API routes.
- [x] Add realtime broadcasting skeleton for queue and now-serving updates.
- [x] Add async jobs baseline (Redis + queue worker skeleton for retries/scheduled jobs).
- [x] Define admin configuration API surface stubs (resets/templates/mapping/retention).

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
- Shared teller auth wrapper now centralizes principal extraction and RBAC guard invocation before route handlers.
- `POST /auth/login` added with email/password verification, role resolution, and access/refresh token issuance skeleton.
- Auth module now includes password-hash verification helpers and JWT signing utilities for baseline login flow.
- App-level request context now generates/propagates `x-request-id` and maps authenticated principal before teller route execution.
- `POST /auth/refresh` added with refresh-token verification and role-aware token re-issuance baseline.
- `POST /auth/logout` skeleton added with refresh-token validation and no-op revocation response until persistence layer is introduced.
- Added focused auth refresh tests in `src/auth/__tests__/refresh.test.ts`.
- Runtime now boots through NestJS (`NestFactory`) and dynamic module/controller wiring while preserving existing request translation in `src/api/server.ts`.
- Password hashing now uses Argon2id for new hashes; verification still supports legacy formats (`scrypt`, `hmac-sha256`, non-prod `plain`) with `needsRehash` for migration.
- Added packaging/reproducibility baseline: `package.json`, `package-lock.json`, `.env.example`, `docker-compose.yml`.
- Added Socket.IO realtime skeleton in `src/realtime/*` with server attachment during bootstrap and subscription rooms by service/station.
- Teller mutation routes now emit baseline realtime events (`queue.updated`, `now-serving.updated`) after successful operations.
- Added reusable route guard enforcement path in `src/api/server.ts` to authenticate principals and enforce role-based access policy before protected route execution.
- Added async jobs baseline in `src/jobs/*` using Redis + BullMQ (`Queue`, `Worker`, `QueueEvents`) with startup/shutdown lifecycle wiring in `src/main.ts`.
- Runtime env contract now requires `REDIS_URL` in `src/runtime/env.ts` and includes baseline Redis config in `.env.example`.
- Added RBAC-protected admin configuration API stubs in `src/api/server.ts` for templates, mapping, retention, and service-counter reset surfaces.
- Replaced admin configuration stubs with persistence-backed handlers in `src/api/server.ts` using `MessageTemplate`, `Device` mapping updates, and `AuditLog` persistence for retention and reset requests.

## Next Slice (Immediate)
1. Begin Phase 4 kickoff planning (patient channels: kiosk + patient PWA).

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
