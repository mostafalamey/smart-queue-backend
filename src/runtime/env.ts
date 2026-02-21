export interface RuntimeEnv {
  port: number;
  databaseUrl: string;
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
  jwtAccessTokenExpiresInSeconds: number;
  jwtRefreshTokenExpiresInSeconds: number;
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

export const loadRuntimeEnv = (): RuntimeEnv => {
  const env = process.env as Record<string, string | undefined>;

  return {
    port: parsePort(env.PORT),
    databaseUrl: requireEnv(env.DATABASE_URL, "DATABASE_URL"),
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
  };
};
