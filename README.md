# Smart Queue Backend

Core API and queue engine service for Smart Queue (NestJS + PostgreSQL + Redis/BullMQ).

## Initial Scope
- Domain model + RBAC foundation
- Queue engine transactional rules
- Auth + API + realtime gateway
- Prisma schema/migrations foundation

## Current Progress
- Phase 1 complete on `main` (domain model, RBAC, contracts, Prisma schema foundation)
- Phase 2 started on feature branch (`queue engine core service and rules`)
- Phase 2 includes framework-agnostic teller API handlers wired to queue engine service
- Phase 3 started on `feature/backend-core-services` with initial checklist in `docs/phase-3-backend-core-services.md`
- Phase 3 auth/RBAC foundation slice started on `feature/backend-auth-rbac-foundation`
- Phase 3 login/token baseline slice added (`POST /auth/login` with token issuance skeleton)

## Branch Workflow
- main: reviewed merges only
- feature/*: one feature per branch/PR

## Local Setup
- Copy `.env.example` to `.env` and set secrets/connection strings.
- Install dependencies: `npm install`
- Start backend locally: `npm run dev`

## Docker Compose Baseline
- Start stack (api + postgres + redis): `docker compose up -d`
- Stop stack: `docker compose down`

## Focused Queue Engine Tests (Phase 2)
- Run from backend repo root: `./scripts/run-queue-engine-tests.ps1`
- If PowerShell execution policy blocks scripts: `powershell -ExecutionPolicy Bypass -File .\scripts\run-queue-engine-tests.ps1`
- CI also runs these focused tests on pull requests to `main` via `.github/workflows/queue-engine-tests.yml`.

## Focused Auth Tests
- Run from backend repo root: `npm run test:auth`
