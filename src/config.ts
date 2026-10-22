const env = process.env;

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export const config = {
  publicUrl: (env.PUBLIC_URL ?? "http://localhost:8083").replace(/\/+$/, ""),
  port: int(env.PORT, 8083),
  host: env.HOST ?? "0.0.0.0",
  dbPath: env.DB_PATH ?? "./data/relay.sqlite",
  liveTimeoutMs: int(env.LIVE_TIMEOUT_MS, 20_000),
  approvalWaitMs: int(env.APPROVAL_WAIT_MS, 40_000),
  pendingTtlMs: int(env.PENDING_TTL_MS, 600_000),
  maxResultBytes: int(env.MAX_RESULT_BYTES, 512 * 1024),
  apns: {
    keyId: env.APNS_KEY_ID ?? "",
    teamId: env.APNS_TEAM_ID ?? "",
    keyPath: env.APNS_KEY_PATH ?? "",
    topic: env.APNS_TOPIC ?? "",
    production: env.APNS_ENV === "production",
  },
  devPushForAll: env.DEV_PUSH_FOR_ALL === "true",
  /** Only behind a reverse proxy that overwrites X-Forwarded-For: "true", or an IP/CIDR list. */
  trustProxy: env.TRUST_PROXY === "true" ? true : env.TRUST_PROXY ? env.TRUST_PROXY.split(",").map((s) => s.trim()) : false,
  version: "0.1.0",
};

export type Config = typeof config;
