/// <reference types="node" />
/**
 * Development seed script — creates a minimal hospital, departments, services,
 * priority categories, and one admin user for local kiosk testing.
 *
 * Usage:  npx jiti scripts/seed.ts
 *   or:   npm run seed
 *
 * Safe to re-run: uses upserts throughout so it won't create duplicates.
 *
 * Credential logging:
 *   By default the admin password is redacted in output to avoid leaking it in
 *   CI logs or shell history. Set SEED_PRINT_CREDENTIALS=true to print it.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { createArgon2idPasswordHash } from "../src/auth/password";

const prisma = new PrismaClient();

const HOSPITAL_ID = "hospital-seed-001";

async function main() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();

  if (nodeEnv === "production" && process.env.ALLOW_SEED_IN_PROD !== "true") {
    console.error(
      "[seed] ERROR: Refusing to seed in production environment.\n" +
        "       Set ALLOW_SEED_IN_PROD=true to override (use with extreme caution)."
    );
    process.exit(1);
  }

  console.log("[seed] Starting...");

  // ── 1. Hospital ─────────────────────────────────────────────────────────────
  const hospital = await prisma.hospital.upsert({
    where: { id: HOSPITAL_ID },
    update: {},
    create: {
      id: HOSPITAL_ID,
      nameAr: "مستشفى السلام",
      nameEn: "Al-Salam Hospital",
      timezone: "Asia/Riyadh",
      address: "123 Healthcare Blvd",
    },
  });
  console.log(`[seed] Hospital: ${hospital.nameEn}`);

  // ── 2. Priority categories ───────────────────────────────────────────────────
  const priorities = [
    { code: "NORMAL",    nameAr: "عادي",    nameEn: "Normal",    weight: 1, isSystem: true },
    { code: "VIP",       nameAr: "كبار",    nameEn: "VIP",       weight: 2, isSystem: true },
    { code: "EMERGENCY", nameAr: "طارئ",    nameEn: "Emergency", weight: 3, isSystem: true },
  ];

  for (const p of priorities) {
    await prisma.priorityCategory.upsert({
      where: { hospitalId_code: { hospitalId: hospital.id, code: p.code } },
      update: {},
      create: { ...p, hospitalId: hospital.id },
    });
  }
  console.log("[seed] Priority categories: Normal, VIP, Emergency");

  // ── 3. Departments ───────────────────────────────────────────────────────────
  const depts = [
    { id: "dept-seed-general", nameAr: "الطب العام",  nameEn: "General Medicine" },
    { id: "dept-seed-lab",     nameAr: "المختبر",     nameEn: "Laboratory" },
    { id: "dept-seed-radiology", nameAr: "الأشعة",   nameEn: "Radiology" },
  ];

  for (const d of depts) {
    await prisma.department.upsert({
      where: { id: d.id },
      update: {},
      create: { ...d, hospitalId: hospital.id, isActive: true },
    });
  }
  console.log(`[seed] Departments: ${depts.map((d) => d.nameEn).join(", ")}`);

  // ── 4. Services ──────────────────────────────────────────────────────────────
  const services = [
    {
      id: "svc-seed-general-clinic",
      departmentId: "dept-seed-general",
      nameAr: "عيادة عامة",
      nameEn: "General Clinic",
      ticketPrefix: "GEN",
      estimatedWaitMinutes: 10,
    },
    {
      id: "svc-seed-family-med",
      departmentId: "dept-seed-general",
      nameAr: "طب الأسرة",
      nameEn: "Family Medicine",
      ticketPrefix: "FAM",
      estimatedWaitMinutes: 15,
    },
    {
      id: "svc-seed-blood-test",
      departmentId: "dept-seed-lab",
      nameAr: "تحليل دم",
      nameEn: "Blood Test",
      ticketPrefix: "LAB",
      estimatedWaitMinutes: 5,
    },
    {
      id: "svc-seed-urine-test",
      departmentId: "dept-seed-lab",
      nameAr: "تحليل بول",
      nameEn: "Urine Test",
      ticketPrefix: "URI",
      estimatedWaitMinutes: 5,
    },
    {
      id: "svc-seed-xray",
      departmentId: "dept-seed-radiology",
      nameAr: "أشعة سينية",
      nameEn: "X-Ray",
      ticketPrefix: "XRY",
      estimatedWaitMinutes: 20,
    },
  ];

  for (const s of services) {
    await prisma.service.upsert({
      where: { id: s.id },
      update: {},
      create: { ...s, isActive: true },
    });
  }
  console.log(`[seed] Services: ${services.map((s) => s.nameEn).join(", ")}`);

  // ── 5. Admin user ────────────────────────────────────────────────────────────
  const adminEmail = "admin@hospital.local";
  const adminPassword = "Admin@SmartQueue1";
  const printCredentials =
    process.env.SEED_PRINT_CREDENTIALS?.trim().toLowerCase() === "true";
  const passwordHash = await createArgon2idPasswordHash(adminPassword);

  const adminUser = await prisma.user.upsert({
    where: { hospitalId_email: { hospitalId: hospital.id, email: adminEmail } },
    update: {},
    create: {
      hospitalId: hospital.id,
      email: adminEmail,
      passwordHash,
      isActive: true,
      mustChangePassword: true,
    },
  });

  const existingRole = await prisma.roleAssignment.findFirst({
    where: { userId: adminUser.id, role: "ADMIN", departmentId: null },
  });
  if (!existingRole) {
    await prisma.roleAssignment.create({
      data: { userId: adminUser.id, role: "ADMIN" },
    });
  }

  if (printCredentials) {
    console.log(`[seed] Admin user: ${adminEmail} / password: ${adminPassword}`);
  } else {
    console.log(`[seed] Admin user: ${adminEmail} / password: <redacted — set SEED_PRINT_CREDENTIALS=true to reveal>`);
  }
  console.log("[seed] NOTE: mustChangePassword=true — change on first login.");

  // ── 6. Counter stations (one per service for testing) ────────────────────────
  const stations = [
    { id: "stn-seed-gen-1",  hospitalId: hospital.id, serviceId: "svc-seed-general-clinic", counterCode: "G01" },
    { id: "stn-seed-fam-1",  hospitalId: hospital.id, serviceId: "svc-seed-family-med",     counterCode: "F01" },
    { id: "stn-seed-lab-1",  hospitalId: hospital.id, serviceId: "svc-seed-blood-test",     counterCode: "L01" },
    { id: "stn-seed-uri-1",  hospitalId: hospital.id, serviceId: "svc-seed-urine-test",     counterCode: "L02" },
    { id: "stn-seed-xry-1",  hospitalId: hospital.id, serviceId: "svc-seed-xray",           counterCode: "R01" },
  ];

  for (const stn of stations) {
    await prisma.counterStation.upsert({
      where: { id: stn.id },
      update: {},
      create: { ...stn, isActive: true },
    });
  }
  console.log(`[seed] Counter stations: ${stations.map((s) => s.counterCode).join(", ")}`);

  // ── 7. Teller device mapping ──────────────────────────────────────────────────
  // Device ID is the persistent UUID written to disk by the Electron app on first
  // launch. Register it here and bind it to the General Clinic counter (G01) so
  // the teller app can resolve its station before login.
  const tellerDevice = await prisma.device.upsert({
    where: { deviceId: "844a4bd0-f194-4574-8aa9-f4859d20bbda" },
    update: {
      assignedCounterStationId: "stn-seed-gen-1",
      isActive: true,
    },
    create: {
      hospitalId: hospital.id,
      deviceId: "844a4bd0-f194-4574-8aa9-f4859d20bbda",
      deviceType: "TELLER_PC",
      displayName: "Dev Teller PC — G01",
      assignedCounterStationId: "stn-seed-gen-1",
      isActive: true,
    },
  });
  console.log(`[seed] Teller device: ${tellerDevice.deviceId} → station G01 (General Clinic)`);

  // ── 8. Staff (teller) user ────────────────────────────────────────────────────
  const staffEmail = "teller@hospital.local";
  const staffPassword = "Staff@SmartQueue1";
  const staffPasswordHash = await createArgon2idPasswordHash(staffPassword);

  const staffUser = await prisma.user.upsert({
    where: { hospitalId_email: { hospitalId: hospital.id, email: staffEmail } },
    update: {},
    create: {
      hospitalId: hospital.id,
      email: staffEmail,
      passwordHash: staffPasswordHash,
      isActive: true,
      mustChangePassword: true,
    },
  });

  const existingStaffRole = await prisma.roleAssignment.findFirst({
    where: { userId: staffUser.id, role: "STAFF" },
  });
  if (!existingStaffRole) {
    await prisma.roleAssignment.create({
      data: { userId: staffUser.id, role: "STAFF" },
    });
  }

  if (printCredentials) {
    console.log(`[seed] Staff user: ${staffEmail} / password: ${staffPassword}`);
  } else {
    console.log(`[seed] Staff user: ${staffEmail} / password: <redacted — set SEED_PRINT_CREDENTIALS=true to reveal>`);
  }

  console.log("\n[seed] Done. Summary:");
  console.log(`  API base URL : http://localhost:3000`);
  console.log(`  GET /departments          → lists 3 departments`);
  console.log(`  GET /departments/:id/services → lists services`);
  console.log(`  POST /tickets             → issues a ticket`);
  if (printCredentials) {
    console.log(`  POST /auth/login          → { email: '${adminEmail}', password: '${adminPassword}' }`);
  } else {
    console.log(`  POST /auth/login          → { email: '${adminEmail}', password: '<redacted>' }`);
  }
}

main()
  .catch((e) => {
    console.error("[seed] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
