import { createHmac } from "node:crypto";
import {
  createArgon2idPasswordHash,
  createScryptPasswordHash,
  verifyPasswordHash,
  verifyPasswordHashWithMetadata,
} from "../password";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[auth-password] ${name} failed: ${reason}`);
  }
};

const originalNodeEnv = process.env.NODE_ENV;

const setNodeEnv = (value: string | undefined): void => {
  process.env.NODE_ENV = value;
};

const createHmacHash = (password: string, salt: string): string => {
  const digest = createHmac("sha256", salt).update(password).digest("hex");
  return `hmac-sha256:${salt}:${digest}`;
};

const run = async (): Promise<void> => {
await runTest("allows plain password verification outside production", async () => {
  setNodeEnv("development");

  equal(await verifyPasswordHash("secret", "plain:secret"), true);
  equal(await verifyPasswordHash("wrong", "plain:secret"), false);
});

await runTest("rejects plain password hashes in production", async () => {
  setNodeEnv("production");

  equal(await verifyPasswordHash("secret", "plain:secret"), false);
});

await runTest("verifies argon2id hashes in production", async () => {
  setNodeEnv("production");

  const hash = await createArgon2idPasswordHash("S3cret!");

  equal(await verifyPasswordHash("S3cret!", hash), true);
  equal(await verifyPasswordHash("bad", hash), false);

  const metadata = await verifyPasswordHashWithMetadata("S3cret!", hash);
  equal(metadata.isValid, true);
  equal(metadata.needsRehash, false);
});

await runTest("verifies legacy scrypt hashes and marks needsRehash", async () => {
  setNodeEnv("production");

  const hash = createScryptPasswordHash("S3cret!");

  equal(await verifyPasswordHash("S3cret!", hash), true);
  equal(await verifyPasswordHash("bad", hash), false);

  const metadata = await verifyPasswordHashWithMetadata("S3cret!", hash);
  equal(metadata.isValid, true);
  equal(metadata.needsRehash, true);
});

await runTest("keeps legacy hmac verification for migration and marks needsRehash", async () => {
  setNodeEnv("production");

  const password = "S3cret!";
  const hash = createHmacHash(password, "salt-1");

  equal(await verifyPasswordHash(password, hash), true);
  equal(await verifyPasswordHash("bad", hash), false);

  const metadata = await verifyPasswordHashWithMetadata(password, hash);
  equal(metadata.isValid, true);
  equal(metadata.needsRehash, true);
});

await runTest("fails closed for unknown hash formats", async () => {
  setNodeEnv("production");

  const metadata = await verifyPasswordHashWithMetadata(
    "any-password",
    "unknown-format-hash-value"
  );

  equal(metadata.isValid, false);
  equal(metadata.needsRehash, false);
  equal(await verifyPasswordHash("unknown-format-hash-value", "unknown-format-hash-value"), false);
});

setNodeEnv(originalNodeEnv);
};

void run();
