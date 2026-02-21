import { createHmac } from "node:crypto";
import {
  createScryptPasswordHash,
  verifyPasswordHash,
  verifyPasswordHashWithMetadata,
} from "../password";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
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

runTest("allows plain password verification outside production", () => {
  setNodeEnv("development");

  equal(verifyPasswordHash("secret", "plain:secret"), true);
  equal(verifyPasswordHash("wrong", "plain:secret"), false);
});

runTest("rejects plain password hashes in production", () => {
  setNodeEnv("production");

  equal(verifyPasswordHash("secret", "plain:secret"), false);
});

runTest("verifies scrypt hashes in production", () => {
  setNodeEnv("production");

  const hash = createScryptPasswordHash("S3cret!");

  equal(verifyPasswordHash("S3cret!", hash), true);
  equal(verifyPasswordHash("bad", hash), false);

  const metadata = verifyPasswordHashWithMetadata("S3cret!", hash);
  equal(metadata.isValid, true);
  equal(metadata.needsRehash, false);
});

runTest("keeps legacy hmac verification for migration and marks needsRehash", () => {
  setNodeEnv("production");

  const password = "S3cret!";
  const hash = createHmacHash(password, "salt-1");

  equal(verifyPasswordHash(password, hash), true);
  equal(verifyPasswordHash("bad", hash), false);

  const metadata = verifyPasswordHashWithMetadata(password, hash);
  equal(metadata.isValid, true);
  equal(metadata.needsRehash, true);
});

runTest("fails closed for unknown hash formats", () => {
  setNodeEnv("production");

  const metadata = verifyPasswordHashWithMetadata(
    "any-password",
    "unknown-format-hash-value"
  );

  equal(metadata.isValid, false);
  equal(metadata.needsRehash, false);
  equal(verifyPasswordHash("unknown-format-hash-value", "unknown-format-hash-value"), false);
});

setNodeEnv(originalNodeEnv);
