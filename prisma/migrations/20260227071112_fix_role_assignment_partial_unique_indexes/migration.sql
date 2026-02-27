-- Migration: fix RoleAssignment uniqueness constraints
--
-- The original migration created a plain unique index on (userId, role, departmentId).
-- In PostgreSQL, NULL != NULL in unique indexes, so two global role assignments
-- (departmentId IS NULL) with the same userId + role were NOT prevented.
--
-- This migration replaces the plain index with two partial unique indexes:
--   1. Department-scoped:  (userId, role, departmentId) WHERE departmentId IS NOT NULL
--   2. Global (no dept):   (userId, role)               WHERE departmentId IS NULL

-- DropIndex
DROP INDEX "RoleAssignment_userId_role_departmentId_key";

-- CreateIndex: partial unique index for department-scoped roles
CREATE UNIQUE INDEX "RoleAssignment_userId_role_dept_key" ON "RoleAssignment"("userId", "role", "departmentId") WHERE "departmentId" IS NOT NULL;

-- CreateIndex: partial unique index for global roles
CREATE UNIQUE INDEX "RoleAssignment_userId_role_global_key" ON "RoleAssignment"("userId", "role") WHERE "departmentId" IS NULL;
