// Phone-facing REST + WebSocket API and the public waitlist endpoint.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Device, Store } from "./db.ts";
import type { Hub } from "./hub.ts";
import { PROTOCOL_VERSION, isPhoneAnswer } from "./protocol.ts";

/** Fixed-window limiter kept in RAM (key → count). Good enough for one process. */
export class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  limit: number;
  windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now > h.reset) {
      if (this.hits.size > 50_000) {
        // evict expired windows only — clearing everything would reset every limit
        for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
      }
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function registerApi(app: FastifyInstance, deps: { store: Store; hub: Hub; config: Config }) {
  const { store, hub, config } = deps;
  const register = new Limiter(10, 60 * 60_000);
  const waitlist = new Limiter(5, 60 * 60_000);
  const deviceCalls = new Limiter(240, 60_000);

  const deviceOf = (req: FastifyRequest): Device | undefined => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? store.authDevice(h.slice(7).trim()) : undefined;
  };
  const auth = (req: FastifyRequest, reply: FastifyReply): Device | undefined => {
    const d = deviceOf(req);
    if (!d) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!deviceCalls.take(d.id)) {
      reply.code(429).send({ error: "slow down" });
      return;
    }
    return d;
  };
  const mcpUrl = (secret: string) => `${config.publicUrl}/mcp/${secret}`;

  app.get("/healthz", async () => ({ ok: true, version: config.version, phones_online: hub.online }));

  // ── device identity (no account, no email) ───────────────────────────────
  app.post("/v1/devices", async (req, reply) => {
    if (!register.take(req.ip)) return reply.code(429).send({ error: "too many registrations" });
    const { device, deviceToken } = store.createDevice();
    return reply.code(201).send({ device_id: device.id, device_token: deviceToken, protocol: PROTOCOL_VERSION });
  });

  app.get("/v1/me", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    return {
      device_id: d.id,
      created_at: d.created_at,
      online: hub.isOnline(d.id),
      push: !!d.apns_token,
      pro_until: d.pro_until,
      connections: store.listConnections(d.id),
    };
  });

  app.delete("/v1/devices/me", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    hub.forget(d.id);
    store.deleteDevice(d.id);
    return reply.code(204).send();
  });

  app.put<{ Body: { token?: string | null; env?: string } }>("/v1/push-token", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    const t = req.body?.token ?? null;
    if (t !== null && !/^[0-9a-fA-F]{64,200}$/.test(t)) return reply.code(400).send({ error: "bad token" });
    store.setPushToken(d.id, t, req.body?.env === "production" ? "production" : "sandbox");
    return { ok: true };
  });

  // ── AI connections: one per AI client, each with its own secret ───────────
  app.post<{ Body: { label?: string } }>("/v1/connections", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    if (store.listConnections(d.id).length >= 12) return reply.code(409).send({ error: "too many connections — revoke one first" });
    const label = String(req.body?.label ?? "AI").trim().slice(0, 40) || "AI";
    const { connection, secret } = store.createConnection(d.id, label);
    return reply.code(201).send({ ...connection, mcp_url: mcpUrl(secret), bearer_token: secret, mcp_base: `${config.publicUrl}/mcp` });
  });

  app.get("/v1/connections", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    return { connections: store.listConnections(d.id) };
  });

  app.delete<{ Params: { id: string } }>("/v1/connections/:id", async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    return store.revokeConnection(d.id, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
  });

  // ── answers sent over HTTPS (from a notification action, no WebSocket) ────
  app.post("/v1/answers", { bodyLimit: config.maxResultBytes * 2 }, async (req, reply) => {
    const d = auth(req, reply);
    if (!d) return;
    if (!isPhoneAnswer(req.body)) return reply.code(400).send({ error: "bad answer" });
    const bytes = Number(req.headers["content-length"]) || config.maxResultBytes * 2;
    return hub.answer(d.id, req.body, bytes) ? { accepted: true } : reply.code(410).send({ accepted: false, error: "request expired or unknown" });
  });

  // ── live socket ──────────────────────────────────────────────────────────
  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    const d = deviceOf(req);
    if (!d) {
      socket.close(4401, "unauthorized");
      return;
    }
    hub.attach(d, socket);
  });

  // ── waitlist (landing page) ──────────────────────────────────────────────
  app.post<{ Body: { email?: string; website?: string } }>("/api/waitlist", async (req, reply) => {
    if (!waitlist.take(req.ip)) return reply.code(429).send({ error: "Too many attempts — try again later." });
    if (req.body?.website) return { ok: true }; // honeypot
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return reply.code(400).send({ error: "That email doesn’t look right." });
    store.addWaitlist(email);
    return { ok: true };
  });
}
