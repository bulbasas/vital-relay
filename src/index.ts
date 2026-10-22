import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { Apns } from "./apns.ts";
import { registerApi } from "./api.ts";
import { registerMcp } from "./mcp.ts";

// URLs can carry connection secrets (/mcp/<secret>) — never log them.
const redact = (url: string) => url.replace(/\/mcp\/[^/?#]+/, "/mcp/[secret]").replace(/\?.*$/, "");

const scrub = (s: string) => s.replace(/rly_[\w-]+/g, "rly_[secret]").replace(/\/mcp\/[^\s"'/?#]+/g, "/mcp/[secret]");

const app = Fastify({
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 1024,
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // last line of defence: scrub secrets from every log call, including framework messages
    hooks: {
      logMethod(args, method) {
        const clean = args.map((a: unknown) => {
          if (typeof a === "string") return scrub(a);
          if (a && typeof a === "object" && !Array.isArray(a) && !(a instanceof Error)) {
            const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
            for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = scrub(o[k] as string);
            return o;
          }
          return a;
        });
        return method.apply(this, clean as Parameters<typeof method>);
      },
    },
    serializers: {
      req: (req) => ({ method: req.method, url: redact(req.url), ip: req.ip }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  },
});

const store = new Store(config.dbPath);
const apns = new Apns(config.apns);
const hub = new Hub({
  approvalWaitMs: config.approvalWaitMs,
  pendingTtlMs: config.pendingTtlMs,
  maxResultBytes: config.maxResultBytes,
  serverVersion: config.version,
  canPush: (d) => apns.enabled && !!d.apns_token && (config.devPushForAll || (d.pro_until ?? 0) > Date.now()),
  notify: (d, r) => apns.notifyRequest(d, r, config.pendingTtlMs),
  log: (msg, data) => app.log.info(data ?? {}, msg),
});
const beat = setInterval(() => hub.heartbeat(), 25_000);

// Strict headers for the landing page: everything is first-party.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

app.addHook("onSend", async (req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  const ct = String(reply.getHeader("content-type") ?? "");
  if (ct.startsWith("text/html")) {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Frame-Options", "DENY");
  }
  return payload;
});

await app.register(websocket, { options: { maxPayload: config.maxResultBytes * 2 } });
registerApi(app, { store, hub, config });
registerMcp(app, { store, hub, config });

// our own 404: Fastify's default one logs the raw URL (which may carry a secret)
app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

await app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../public", import.meta.url)),
  setHeaders(res, path) {
    if (/\.(woff2|png|svg|ico)$/.test(path)) res.header("Cache-Control", "public, max-age=2592000, immutable");
    else res.header("Cache-Control", "public, max-age=300");
  },
});

const shutdown = async () => {
  clearInterval(beat);
  hub.close();
  apns.close();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info({ publicUrl: config.publicUrl, apns: apns.enabled, stats: store.stats() }, "relay ready");
