import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;

const isProductionEnvironment = (): boolean => {
  const nodeEnv = (process.env.NODE_ENV ?? "").toLowerCase();
  return nodeEnv === "production";
};

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  const paddedLength = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(paddedLength, 0x00);
  const paddedRight = Buffer.alloc(paddedLength, 0x00);

  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  const equal = timingSafeEqual(paddedLeft, paddedRight);
  const sameLength = leftBuffer.length === rightBuffer.length;
  return equal && sameLength;
};

const isHex = (value: string): boolean => /^[0-9a-f]+$/i.test(value);

const deriveScryptHex = (
  password: string,
  saltHex: string,
  keyLength: number,
  n: number,
  r: number,
  p: number
): string => {
  return scryptSync(password, Buffer.from(saltHex, "hex"), keyLength, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAX_MEMORY_BYTES,
  }).toString("hex");
};

const verifyScryptPassword = (password: string, storedHash: string): boolean => {
  const parts = storedHash.split(":");
  if (parts.length !== 6) {
    return false;
  }

  const [prefix, nRaw, rRaw, pRaw, saltHex, digestHex] = parts;
  if (prefix !== SCRYPT_PREFIX) {
    return false;
  }

  if (!saltHex || !digestHex || !isHex(saltHex) || !isHex(digestHex)) {
    return false;
  }

  if (saltHex.length % 2 !== 0 || digestHex.length % 2 !== 0) {
    return false;
  }

  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  if (n <= 0 || r <= 0 || p <= 0) {
    return false;
  }

  const keyLength = digestHex.length / 2;
  if (keyLength <= 0) {
    return false;
  }

  const derivedHex = deriveScryptHex(password, saltHex, keyLength, n, r, p);
  return constantTimeEquals(derivedHex.toLowerCase(), digestHex.toLowerCase());
};

const verifyHmacSha256Password = (
  password: string,
  storedHash: string
): boolean => {
  const parts = storedHash.split(":");
  if (parts.length !== 3) {
    return false;
  }

  const [, salt, digest] = parts;
  if (!salt || !digest) {
    return false;
  }

  const computedDigest = createHmac("sha256", salt)
    .update(password)
    .digest("hex");

  return constantTimeEquals(computedDigest, digest);
};

export interface PasswordVerificationResult {
  isValid: boolean;
  needsRehash: boolean;
}

export const createScryptPasswordHash = (password: string): string => {
  const saltHex = randomBytes(SCRYPT_SALT_BYTES).toString("hex");
  const digestHex = deriveScryptHex(
    password,
    saltHex,
    SCRYPT_KEY_LENGTH,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P
  );

  return `${SCRYPT_PREFIX}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltHex}:${digestHex}`;
};

export const verifyPasswordHashWithMetadata = (
  password: string,
  storedHash: string
): PasswordVerificationResult => {
  if (storedHash.startsWith("plain:")) {
    if (isProductionEnvironment()) {
      return {
        isValid: false,
        needsRehash: false,
      };
    }

    return {
      isValid: constantTimeEquals(password, storedHash.slice("plain:".length)),
      needsRehash: true,
    };
  }

  if (storedHash.startsWith("hmac-sha256:")) {
    return {
      isValid: verifyHmacSha256Password(password, storedHash),
      needsRehash: true,
    };
  }

  if (storedHash.startsWith(`${SCRYPT_PREFIX}:`)) {
    return {
      isValid: verifyScryptPassword(password, storedHash),
      needsRehash: false,
    };
  }

  return {
    isValid: false,
    needsRehash: false,
  };
};

export const verifyPasswordHash = (
  password: string,
  storedHash: string
): boolean => {
  return verifyPasswordHashWithMetadata(password, storedHash).isValid;
};
