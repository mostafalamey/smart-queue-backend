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

## Branch Workflow
- main: reviewed merges only
- feature/*: one feature per branch/PR
