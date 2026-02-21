import "dotenv/config";

export interface RuntimeEnv {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
  jwtAccessTokenExpiresInSeconds: number;
  jwtRefreshTokenExpiresInSeconds: number;
  realtimeCorsAllowedOrigins: "*" | string[];
}

const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

const parsePort = (rawPort: string | undefined): number => {
  if (!rawPort) {
    return 3000;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const parsed = Number.parseInt(rawPort, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return parsed;
};

const requireEnv = (value: string | undefined, key: string): string => {
  if (!value || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
};

const parsePositiveIntegerWithDefault = (
  rawValue: string | undefined,
  key: string,
  defaultValue: number
): number => {
  if (!rawValue || rawValue.trim().length === 0) {
    return defaultValue;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${key} must be a positive integer`);
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
};

const parseRealtimeCorsAllowedOrigins = (
  rawValue: string | undefined,
  nodeEnv: string
): "*" | string[] => {
  if (!rawValue || rawValue.trim().length === 0) {
    if (nodeEnv === "production") {
      throw new Error(
        "REALTIME_CORS_ALLOWED_ORIGINS is required in production"
      );
    }

    return "*";
  }

  const normalized = rawValue.trim();
  if (normalized === "*") {
    if (nodeEnv === "production") {
      throw new Error(
        "REALTIME_CORS_ALLOWED_ORIGINS cannot be '*' in production"
      );
    }

    return "*";
  }

  const origins = normalized
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error(
      "REALTIME_CORS_ALLOWED_ORIGINS must be '*' or a comma-separated list of origins"
    );
  }

  return origins;
};

export const loadRuntimeEnv = (): RuntimeEnv => {
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase() ?? "development";

  return {
    port: parsePort(env.PORT),
    databaseUrl: requireEnv(env.DATABASE_URL, "DATABASE_URL"),
    redisUrl: requireEnv(env.REDIS_URL, "REDIS_URL"),
    jwtAccessTokenSecret: requireEnv(
      env.JWT_ACCESS_TOKEN_SECRET,
      "JWT_ACCESS_TOKEN_SECRET"
    ),
    jwtRefreshTokenSecret: requireEnv(
      env.JWT_REFRESH_TOKEN_SECRET,
      "JWT_REFRESH_TOKEN_SECRET"
    ),
    jwtAccessTokenExpiresInSeconds: parsePositiveIntegerWithDefault(
      env.JWT_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      "JWT_ACCESS_TOKEN_EXPIRES_IN_SECONDS",
      DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS
    ),
    jwtRefreshTokenExpiresInSeconds: parsePositiveIntegerWithDefault(
      env.JWT_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
      "JWT_REFRESH_TOKEN_EXPIRES_IN_SECONDS",
      DEFAULT_REFRESH_TOKEN_EXPIRES_IN_SECONDS
    ),
    realtimeCorsAllowedOrigins: parseRealtimeCorsAllowedOrigins(
      env.REALTIME_CORS_ALLOWED_ORIGINS,
      nodeEnv
    ),
  };
};
