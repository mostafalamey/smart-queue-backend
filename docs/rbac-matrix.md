# Smart Queue Backend — RBAC Matrix (Phase 1)

Date: 2026-02-20
Phase: 1 (Domain Model + RBAC Foundation)

## Roles
- `ADMIN`: full access
- `IT`: mapping/device/integration/operational settings only
- `MANAGER`: queue control + analytics, scoped to exactly one department
- `STAFF`: teller execution actions, scoped by assigned station/service

## Scope Rules
- `ADMIN`: hospital-wide
- `IT`: hospital-wide for allowed modules
- `MANAGER`: exactly one `departmentId`
- `STAFF`: runtime scope derived from device/station binding

## Resource Permissions (v1)

| Resource / Action | ADMIN | IT | MANAGER | STAFF |
|---|---|---|---|---|
| Organization metadata read/write | ✅ | ❌ | ❌ | ❌ |
| Departments read | ✅ | ❌ | ✅ (own department) | ✅ (own scope) |
| Departments write | ✅ | ❌ | ❌ | ❌ |
| Services read | ✅ | ❌ | ✅ (own department) | ✅ (bound service) |
| Services write (incl. prefix) | ✅ | ❌ | ❌ | ❌ |
| Users create/edit/disable | ✅ | ❌ | ❌ | ❌ |
| Role assignment | ✅ | ❌ | ❌ | ❌ |
| Device mapping read/write | ✅ | ✅ | ❌ | ❌ |
| Counter/station mapping read/write | ✅ | ✅ | ❌ | ❌ |
| Integration config read/write | ✅ | ✅ | ❌ | ❌ |
| Queue summary read | ✅ | ❌ | ✅ (own department) | ✅ (bound service) |
| Ticket lookup | ✅ | ❌ | ✅ (own department) | ✅ (bound service) |
| Ticket lock/unlock | ✅ | ❌ | ✅ (own department) | ❌ |
| Change ticket priority (not yet called) | ✅ | ❌ | ✅ (own department) | ❌ |
| Call next / recall / skip / complete / transfer | ✅ | ❌ | ❌ | ✅ |
| Analytics read | ✅ | ❌ | ✅ (own department) | ❌ |
| Retention policy read/write | ✅ | ✅ | ❌ | ❌ |
| Message template read/write | ✅ | ✅ | ❌ | ❌ |

## Enforced Business Rules
- Manager cannot access data outside assigned department.
- Staff cannot switch service manually in v1.
- Priority change is denied once ticket status is `CALLED` or later.
- Queue reordering endpoint does not exist.

## Authorization Evaluation Order
1. Authenticate token/session.
2. Resolve role assignment + scope.
3. Validate resource-level permission.
4. Validate scope predicate (department/service/station).
5. Validate state predicate (e.g., ticket not called for priority change).
6. Emit `AuditLog` for write operations.

## Implementation Targets
- Server-side guards only (client checks are non-authoritative).
- Reusable policy helpers:
  - `canAccessDepartment(user, departmentId)`
  - `canOperateService(user, serviceId, stationId)`
  - `canChangePriority(ticketStatus)`
