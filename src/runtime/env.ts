export interface RuntimeEnv {
  port: number;
  databaseUrl: string;
  jwtAccessTokenSecret: string;
  jwtRefreshTokenSecret: string;
}

const parsePort = (rawPort: string | undefined): number => {
  if (!rawPort) {
    return 3000;
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
  };
};
