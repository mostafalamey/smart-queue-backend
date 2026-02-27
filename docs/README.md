# Backend Notes

Track architecture and API contract notes here.

## Phase 1 Artifacts
- `domain-model.md`
- `rbac-matrix.md`
- `api-contract-stubs.md`
- `../prisma/schema.prisma`

## Phase 2 Artifacts
- `phase-2-queue-engine.md`
- `../src/queue-engine/`

## Phase 3 Artifacts
- `phase-3-backend-core-services.md`
- `../src/api/server.ts` — all HTTP routes (teller, admin config, kiosk endpoints, CORS)
- `../src/auth/` — JWT, Argon2id, access + rotating refresh tokens
- `../src/realtime/` — Socket.IO broadcaster (NoopBroadcaster when unconfigured)
- `../src/jobs/runtime.ts` — BullMQ async jobs runtime; `createNoopAsyncJobsRuntime()` activates automatically when `REDIS_URL` is absent
- `../src/runtime/env.ts` — environment variable loader (`redisUrl` is optional)
- `../src/main.ts` — bootstrap with conditional noop vs real jobs runtime

## Database — Local Development Setup (Windows)

Production uses Linux + Docker Compose. For local Windows development, install PostgreSQL 16 natively.

```powershell
# In psql as postgres superuser:
CREATE USER smart_queue WITH PASSWORD 'smart_queue';
ALTER USER smart_queue CREATEDB;
CREATE DATABASE smart_queue OWNER smart_queue;

# Then from the backend directory:
npx prisma migrate deploy   # apply migrations
npx prisma generate         # regenerate Prisma client
npm run seed                # seed reference data
```

### Applied Migrations
| Migration | Date | Description |
|---|---|---|
| `20260226200303_init` | 2026-02-26 | Initial full schema |

### Seed Data (scripts/seed.ts)
- Hospital: Al-Salam Hospital (`hospital-seed-001`, timezone: `Asia/Riyadh`)
- Priorities: Normal (weight 1), VIP (weight 2), Emergency (weight 3)
- Departments: General Medicine, Laboratory, Radiology
- Services: General Clinic (GEN), Family Medicine (FAM), Blood Test (LAB), Urine Analysis (URI), X-Ray (XRY)
- Admin user: `admin@hospital.local` / `Admin@SmartQueue1` (mustChangePassword: true)
- Stations: G01, F01, L01, L02, R01

## Kiosk API Endpoints (added in Phase 3/4)

| Method | Path | Auth | Description |
|------|---|---|---|
| GET  | `/departments` | None | List all active departments for the hospital |
| GET  | `/departments/:id/services` | None | List services for a given department |
| POST | `/tickets` | None | Issue a new ticket (duplicate guard, sequence numbering, event logging) |

## Known Pending Items (Phase 3 tail)
- Refresh-token revocation persistence (currently stubbed with a warning)
- Daily midnight sequence-reset job (requires Redis/BullMQ; noop runtime silently skips)
- `GET /tickets/:id` status endpoint (deferred to Phase 12 / patient app)

> See `DEV-SETUP.md` in the workspace root for full local dev setup and server startup instructions.