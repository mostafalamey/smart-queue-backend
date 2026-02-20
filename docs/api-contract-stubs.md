# Smart Queue Backend — API Contract Stubs (Phase 1)

Date: 2026-02-20
Phase: 1 (Domain Model + RBAC Foundation)

Purpose: Define the initial endpoint surface and authorization expectations so frontend channels can begin integration in parallel.

## Auth

### `POST /auth/login`
- Input: `{ email, password, deviceId? }`
- Output: access token + refresh token (transport strategy to be finalized per client type)
- Access: public

### `POST /auth/refresh`
- Input: refresh token/cookie
- Output: rotated tokens
- Access: authenticated refresh context

### `POST /auth/logout`
- Invalidates refresh token session.
- Access: authenticated

### `POST /auth/change-password`
- Input: `{ currentPassword, newPassword }`
- Access: authenticated

## Departments and Services

### `GET /departments`
- Returns departments in scope.
- Access: `ADMIN`, `MANAGER`, scoped staff reads

### `POST /departments`
- Create department.
- Access: `ADMIN`

### `GET /departments/:id/services`
- List services for department.
- Access: scoped reads

### `POST /departments/:id/services`
- Create service with `ticketPrefix`, bilingual names, wait config.
- Access: `ADMIN`

## Tickets / Queue

### `POST /tickets`
- Create ticket from kiosk/patient/whatsapp flows.
- Input includes: `serviceId`, `phoneNumber`, optional `priorityCode` (default NORMAL).
- Must enforce one-active-ticket-per-phone-per-service.
- Access: channel client credentials or internal trusted context.

### `GET /tickets/:ticketId`
- Ticket details + latest status.
- Access: scoped role access.

### `GET /queue/services/:serviceId/summary`
- Waiting/called/serving counts and now serving info.
- Access: scoped role access.

### `POST /queue/tickets/:ticketId/lock`
- Lock ticket for priority edit.
- Access: `ADMIN`, `MANAGER` (scoped)

### `POST /queue/tickets/:ticketId/priority`
- Change priority while not called.
- Access: `ADMIN`, `MANAGER` (scoped)

## Teller Operations

### `POST /teller/call-next`
- Input: `{ stationId }`
- Performs atomic next-ticket selection by priority+FIFO.
- Access: `STAFF`

### `POST /teller/:ticketId/recall`
- Re-announce currently called/serving ticket.
- Access: `STAFF`

### `POST /teller/:ticketId/skip`
- Marks final no-show outcome.
- Access: `STAFF`

### `POST /teller/:ticketId/complete`
- Marks completed.
- Access: `STAFF`

### `POST /teller/:ticketId/transfer`
- Input: `{ destinationServiceId }`
- Creates linked destination ticket.
- Access: `STAFF`

## Devices and Mapping

### `GET /devices`
- Access: `ADMIN`, `IT`

### `POST /devices`
- Register/enroll device by `deviceId`.
- Access: `ADMIN`, `IT`

### `POST /mapping/stations/:stationId/bind-device`
- Bind teller PC device to station.
- Access: `ADMIN`, `IT`

## Messaging / Integration

### `GET /message-templates`
### `POST /message-templates`
- Access: `ADMIN`, `IT`

### `POST /integrations/ultramessage/webhook`
- Inbound provider webhook endpoint (gateway-facing).
- Access: service-auth only

## Analytics

### `GET /analytics/overview`
- Filters: date range, department.
- Access: `ADMIN`, `MANAGER` scoped.

## System / Audit

### `GET /audit-logs`
- Access: `ADMIN`

### `POST /services/:serviceId/reset-counter`
- Manual ticket sequence reset endpoint.
- Access: `ADMIN`, `MANAGER` scoped

## Realtime Events (Socket Namespace Stub)
Namespace: `/queue`
- `queue.updated` -> service queue summary changes
- `ticket.called` -> called ticket + station
- `ticket.recalled`
- `ticket.completed`
- `ticket.transferred`

## Error Contract (Stub)
```json
{
  "code": "DOMAIN_RULE_VIOLATION",
  "message": "Only one active ticket is allowed per phone number per service.",
  "details": {}
}
```
