/// <reference types="node" />
/**
 * Seeds a single teller (STAFF) user scoped to the General Medicine department
 * (which owns the "General Clinic" service).
 *
 * Usage:  npx jiti scripts/seed-teller.ts
 *   or:   npm run seed:teller
 *
 * Safe to re-run: uses upserts/findFirst guards to avoid duplicates.
 *
 * Credentials
 *   Email    : teller.general@hospital.local
 *   Password : Teller@SmartQueue1   (must change on first login)
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { createArgon2idPasswordHash } from "../src/auth/password";

const prisma = new PrismaClient();

const HOSPITAL_ID   = "hospital-seed-001";
const DEPT_ID       = "dept-seed-general";   // General Medicine — owns General Clinic
const TELLER_EMAIL  = "teller.general@hospital.local";
const TELLER_PASS   = "Teller@SmartQueue1";

async function main() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === "production" && process.env.ALLOW_SEED_IN_PROD !== "true") {
    console.error(
      "[seed-teller] ERROR: Refusing to seed in production.\n" +
        "              Set ALLOW_SEED_IN_PROD=true to override."
    );
    process.exit(1);
  }

  console.log("[seed-teller] Starting...");

  // ── Verify hospital & department exist ──────────────────────────────────────
  const hospital = await prisma.hospital.findUnique({ where: { id: HOSPITAL_ID } });
  if (!hospital) {
    console.error(
      "[seed-teller] Hospital not found. Run `npm run seed` first to create base data."
    );
    process.exit(1);
  }

  const dept = await prisma.department.findUnique({ where: { id: DEPT_ID } });
  if (!dept) {
    console.error(
      "[seed-teller] Department not found. Run `npm run seed` first to create base data."
    );
    process.exit(1);
  }

  console.log(`[seed-teller] Hospital : ${hospital.nameEn}`);
  console.log(`[seed-teller] Department: ${dept.nameEn}`);

  // ── Upsert teller user ──────────────────────────────────────────────────────
  const passwordHash = await createArgon2idPasswordHash(TELLER_PASS);

  const tellerUser = await prisma.user.upsert({
    where: { hospitalId_email: { hospitalId: HOSPITAL_ID, email: TELLER_EMAIL } },
    update: {},
    create: {
      hospitalId: HOSPITAL_ID,
      email: TELLER_EMAIL,
      passwordHash,
      isActive: true,
      mustChangePassword: true,
    },
  });

  console.log(`[seed-teller] User upserted: ${tellerUser.email} (id: ${tellerUser.id})`);

  // ── Assign STAFF role scoped to General Medicine department ─────────────────
  // Guard against duplicate: partial unique indexes enforce (userId, role) WHERE
  // departmentId IS NULL (global) and (userId, role, departmentId) WHERE NOT NULL.
  const existingRole = await prisma.roleAssignment.findFirst({
    where: {
      userId: tellerUser.id,
      role: "STAFF",
      departmentId: DEPT_ID,
    },
  });

  if (!existingRole) {
    await prisma.roleAssignment.create({
      data: {
        userId: tellerUser.id,
        role: "STAFF",
        departmentId: DEPT_ID,
      },
    });
    console.log(`[seed-teller] RoleAssignment created: STAFF → ${dept.nameEn}`);
  } else {
    console.log(`[seed-teller] RoleAssignment already exists — skipped.`);
  }

  const printCredentials =
    process.env.SEED_PRINT_CREDENTIALS?.trim().toLowerCase() === "true";

  console.log("\n[seed-teller] Done.");
  console.log(`  Email    : ${TELLER_EMAIL}`);
  if (printCredentials) {
    console.log(`  Password : ${TELLER_PASS}`);
  } else {
    console.log(`  Password : <redacted — set SEED_PRINT_CREDENTIALS=true to reveal>`);
  }
  console.log(`  Role     : STAFF`);
  console.log(`  Dept     : ${dept.nameEn} (owns "General Clinic" service)`);
  console.log(`  mustChangePassword : true`);
}

main()
  .catch((e) => {
    console.error("[seed-teller] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
