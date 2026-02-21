import { createHmac, timingSafeEqual } from "node:crypto";

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
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

export const verifyPasswordHash = (
  password: string,
  storedHash: string
): boolean => {
  if (storedHash.startsWith("plain:")) {
    return constantTimeEquals(password, storedHash.slice("plain:".length));
  }

  if (storedHash.startsWith("hmac-sha256:")) {
    return verifyHmacSha256Password(password, storedHash);
  }

  return constantTimeEquals(password, storedHash);
};
