# Smart Queue Backend — Domain Model (Phase 1)

Date: 2026-02-20
Phase: 1 (Domain Model + RBAC Foundation)

## Scope
This document defines the initial backend domain model for v1 and aligns with:
- On-prem single hospital per installation
- Queue per service (Department -> Service)
- Strict priority + FIFO ordering
- Full ticket lifecycle auditability

## Core Principles
- One installation = one `Hospital`.
- Phone number is mandatory for ticket issuance.
- One active ticket per `phoneNumber + serviceId`.
- Ordering is always priority first, FIFO within priority.
- Queue-changing actions are event-sourced in `TicketEvent`.

## Entities

### Hospital
Represents the local installation context.
- `id` (uuid)
- `nameAr`, `nameEn`
- `address`, `email`, `website`
- `logoPath` (optional)
- `timezone` (default local timezone)
- `createdAt`, `updatedAt`

### Department
Top-level operational unit.
- `id` (uuid)
- `hospitalId` (fk)
- `nameAr`, `nameEn`
- `isActive`
- `createdAt`, `updatedAt`

### Service
Queue unit under a department.
- `id` (uuid)
- `departmentId` (fk)
- `nameAr`, `nameEn`
- `ticketPrefix` (e.g., LAB, A)
- `estimatedWaitMinutes` (optional configured baseline)
- `nearingTurnThreshold` (N people ahead trigger)
- `dailyResetEnabled` (default true)
- `isActive`
- `createdAt`, `updatedAt`

### CounterStation
Physical/virtual teller station bound to one service in v1.
- `id` (uuid)
- `hospitalId` (fk)
- `counterCode` (display identifier)
- `serviceId` (fk)
- `deviceId` (app-generated device id)
- `isActive`
- `createdAt`, `updatedAt`

### User
Authenticated Smart Queue user.
- `id` (uuid)
- `hospitalId` (fk)
- `email` (unique per hospital)
- `passwordHash`
- `isActive`
- `mustChangePassword`
- `failedLoginAttempts`
- `lockedUntil` (optional)
- `avatarPath` (optional)
- `createdAt`, `updatedAt`

### RoleAssignment
Role and scope assignment per user.
- `id` (uuid)
- `userId` (fk)
- `role` (Admin | IT | Manager | Staff)
- `departmentId` (nullable at DB level; required by application logic for Manager and Staff, optional for Admin and IT)
- `createdAt`, `updatedAt`

### PriorityCategory
Hospital-scoped priority definition (linked by `hospitalId`).
- `id` (uuid)
- `hospitalId` (fk)
- `code` (free-form identifier; suggested values: NORMAL | VIP | EMERGENCY)
- `nameAr`, `nameEn`
- `weight` (higher means higher priority)
- `isSystem`
- `createdAt`, `updatedAt`

### Ticket
Queue ticket lifecycle aggregate.
- `id` (uuid)
- `hospitalId` (fk)
- `departmentId` (fk)
- `serviceId` (fk)
- `ticketDate` (local date bucket)
- `sequenceNumber` (daily service sequence)
- `ticketNumber` (rendered: prefix + padded sequence)
- `phoneNumber`
- `priorityCategoryId` (fk)
- `status` (`WAITING`, `CALLED`, `SERVING`, `COMPLETED`, `NO_SHOW`, `CANCELLED`, `TRANSFERRED_OUT`)
- `calledAt`, `servingStartedAt`, `completedAt`, `noShowAt`, `cancelledAt` (nullable)
- `calledCounterStationId` (nullable fk)
- `lockedByUserId` (nullable fk)
- `lockedUntil` (nullable)
- `originTicketId` (nullable self fk for transferred tickets)
- `createdAt`, `updatedAt`

### Ticket State Machine (v1)
Expected lifecycle transitions and timestamp behavior:

- `WAITING -> CALLED`
  - Trigger: teller `Call Next`
  - Sets: `calledAt`
  - Emits event: `CALLED`

- `CALLED -> SERVING`
  - Trigger: explicit teller action when service actually starts (not automatic on call)
  - Sets: `servingStartedAt`
  - Emits event: `SERVING_STARTED`

- `CALLED -> NO_SHOW` or `SERVING -> NO_SHOW`
  - Trigger: teller `Skip`
  - Emits event: `NO_SHOW`

- `SERVING -> COMPLETED`
  - Trigger: teller `Complete`
  - Sets: `completedAt`
  - Emits event: `COMPLETED`

- `WAITING -> CANCELLED`
  - Trigger: patient cancel before call (or authorized admin flow)
  - Sets: `cancelledAt`
  - Emits event: `CANCELLED`

- `WAITING|CALLED|SERVING -> TRANSFERRED_OUT`
  - Trigger: teller `Transfer`
  - Source ticket marked `TRANSFERRED_OUT`; destination ticket created as `WAITING`
  - Emits events: `TRANSFERRED_OUT` (source), `TRANSFERRED_IN` (destination)

Notes:
- `calledAt` and `servingStartedAt` are intentionally separate for analytics (`wait time` vs `actual service start`).
- `Recall` does not change ticket status; it emits `RECALLED` and re-announces the currently called/serving ticket.

### TicketEvent
Immutable lifecycle events for audit + analytics.
- `id` (uuid)
- `ticketId` (fk)
- `eventType` (free-form event key; suggested canonical values include: `CREATED`, `CALLED`, `RECALLED`, `SERVING_STARTED`, `COMPLETED`, `NO_SHOW`, `CANCELLED`, `TRANSFERRED_OUT`, `TRANSFERRED_IN`, `PRIORITY_CHANGED`, `LOCKED`, `UNLOCKED`)
- `actorType` (`USER`, `SYSTEM`, `PATIENT_WHATSAPP`, `PATIENT_PWA`, `KIOSK`)
- `actorUserId` (nullable fk)
- `stationId` (nullable fk)
- `payload` (json)
- `occurredAt`

### MessageTemplate
Configurable messaging templates.
- `id` (uuid)
- `hospitalId` (fk)
- `channel` (`WHATSAPP`)
- `eventType`
- `language` (free-form language code; v1 suggested values: `ar`, `en`)
- `content`
- `isActive`
- `createdAt`, `updatedAt`

### Device
Generic managed device enrollment/config abstraction.
- `id` (uuid)
- `hospitalId` (fk)
- `deviceId` (unique)
- `deviceType` (`KIOSK`, `TELLER_PC`, `SIGNAGE_PLAYER`, `LED_ADAPTER`)
- `displayName`
- `assignedDepartmentId` (nullable)
- `assignedCounterStationId` (nullable)
- `config` (json)
- `isActive`
- `createdAt`, `updatedAt`

### IntegrationConfig
Integration credentials/config pointers (no plaintext secrets in db by default).
- `id` (uuid)
- `hospitalId` (fk)
- `provider` (`ULTRAMESSAGE`)
- `config` (json)
- `isActive`
- `createdAt`, `updatedAt`

### AuditLog
Administrative audit trail.
- `id` (uuid)
- `hospitalId` (fk)
- `actorUserId` (nullable fk)
- `action`
- `entityType`
- `entityId`
- `before` (json nullable)
- `after` (json nullable)
- `occurredAt`

## Key Constraints (v1)
- Unique active ticket per phone and service:
  - logical rule: one ticket in `{WAITING, CALLED, SERVING}` for same `phoneNumber + serviceId`
- Unique service prefix within a department.
- Unique counter code within a hospital.
- Manager must have exactly one department scope.
- Staff must have exactly one department scope.
- One service per counter station.

### TransferReason
Hospital-scoped configurable transfer reason (dropdown for tellers).
- `id` (uuid)
- `hospitalId` (fk)
- `nameAr`
- `nameEn`
- `sortOrder` (int, default 0)
- `isActive` (default true)
- `createdAt`, `updatedAt`

Seeded with defaults: Wrong service, Additional tests required, Doctor referral, Specialist consultation needed, Other.

## Transfer Model
Transfer creates a new destination ticket and links back:
- Source ticket marked `TRANSFERRED_OUT`.
- Destination ticket references `originTicketId`.
- Destination ticket gets new sequence and ticket number for destination service/date bucket.
- Priority preserved by default.
- Teller must select a `TransferReason` when transferring; the `reasonId` + denormalized `reasonNameEn`/`reasonNameAr` are recorded in the `TRANSFERRED_OUT` and `TRANSFERRED_IN` event payloads for audit/analytics.
- Transfer reasons are managed by Admin via the Admin app (CRUD + ordering + soft-deactivation).

## Open Design Notes for Phase 2
- Ticket lock timeout duration.
- Optimistic vs pessimistic locking strategy for `call next`.
- Retention/pseudonymization strategy for phone numbers.
