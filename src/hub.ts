// In-memory routing between AI tool calls and phones. Nothing here is persisted:
// a restart drops every socket and every pending answer.
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Connection, Device } from "./db.ts";
import {
  PROTOCOL_VERSION,
  isPhoneAnswer,
  type ErrorCode,
  type PhoneAnswer,
  type ResponseMeta,
  type ServerRequest,
  type ToPhone,
  type ToolResult,
} from "./protocol.ts";

export type Outcome =
  | { status: "ok"; result: ToolResult; meta?: ResponseMeta; ms: number }
  | { status: "error"; code: ErrorCode; message: string }
  | { status: "pending"; requestId: string; via: "live" | "push" }
  | { status: "offline"; reason: "no_push" | "push_failed" };

type Pending = {
  id: string;
  device: Device;
  connection: Connection;
  request: ServerRequest;
  createdAt: number;
  expiresAt: number;
  delivered: boolean;
  answer?: PhoneAnswer;
  answeredAt?: number;
  /** bytes of an answer held for later pickup (0 when handed straight to a waiting caller) */
  heldBytes: number;
  waiters: Set<(a: PhoneAnswer) => void>;
};

// Memory guards — one device or one leaked connection must not be able to exhaust the relay.
const MAX_PENDING_PER_DEVICE = 32;
const MAX_HELD_BYTES_PER_DEVICE = 2 * 1024 * 1024;
const MAX_HELD_BYTES_TOTAL = 64 * 1024 * 1024;
const SOCKET_WINDOW_MS = 10_000;
const SOCKET_MAX_MESSAGES = 60;
const SOCKET_MAX_BYTES = 8 * 1024 * 1024;

export type Notifier = (device: Device, req: ServerRequest) => Promise<boolean>;

export type HubOptions = {
  approvalWaitMs: number;
  pendingTtlMs: number;
  maxResultBytes: number;
  serverVersion: string;
  canPush: (device: Device) => boolean;
  notify: Notifier;
  log: (msg: string, data?: Record<string, unknown>) => void;
};

const rid = () => "r_" + randomBytes(6).toString("base64url");

export class Hub {
  private sockets = new Map<string, WebSocket>();
  private alive = new WeakMap<WebSocket, boolean>();
  private pending = new Map<string, Pending>();
  private heldTotal = 0;
  private heldByDevice = new Map<string, number>();
  private timer: NodeJS.Timeout;
  private opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref();
  }

  get online() {
    return this.sockets.size;
  }

  isOnline(deviceId: string) {
    const ws = this.sockets.get(deviceId);
    return !!ws && ws.readyState === ws.OPEN;
  }

  // ── phone sockets ─────────────────────────────────────────────────────────
  attach(device: Device, ws: WebSocket) {
    const prev = this.sockets.get(device.id);
    if (prev && prev !== ws) prev.close(4000, "replaced by a newer connection");
    this.sockets.set(device.id, ws);
    this.alive.set(ws, true);
    this.opts.log("phone connected", { device: device.id.slice(0, 8) });

    ws.on("pong", () => this.alive.set(ws, true));
    let windowStart = Date.now();
    let windowMessages = 0;
    let windowBytes = 0;
    ws.on("message", (data, isBinary) => {
      // a listener that throws would take the whole process down — never let it
      try {
        if (isBinary) return;
        const raw = data.toString();
        const bytes = Buffer.byteLength(raw);
        const now = Date.now();
        if (now - windowStart > SOCKET_WINDOW_MS) {
          windowStart = now;
          windowMessages = 0;
          windowBytes = 0;
        }
        windowMessages++;
        windowBytes += bytes;
        if (windowMessages > SOCKET_MAX_MESSAGES || windowBytes > SOCKET_MAX_BYTES) {
          ws.close(1008, "rate limit");
          return;
        }
        if (bytes > this.opts.maxResultBytes * 1.2) {
          ws.close(1009, "message too large");
          return;
        }
        const msg: unknown = JSON.parse(raw);
        if (isPhoneAnswer(msg)) this.answer(device.id, msg, bytes);
      } catch {
        ws.close(1008, "bad message");
      }
    });
    ws.on("close", () => {
      if (this.sockets.get(device.id) === ws) this.sockets.delete(device.id);
      this.opts.log("phone disconnected", { device: device.id.slice(0, 8) });
    });

    this.send(ws, {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      device_id: device.id,
      server_time: new Date().toISOString(),
      server_version: this.opts.serverVersion,
    });
    // requests that arrived while the phone was away (e.g. it was opened from a notification)
    for (const p of this.pending.values()) {
      if (p.device.id === device.id && !p.answer && Date.now() < p.request.deadline + this.opts.pendingTtlMs) {
        p.delivered = this.send(ws, p.request);
      }
    }
  }

  /** Heartbeat: call periodically; terminates sockets that missed a pong. */
  heartbeat() {
    for (const [id, ws] of this.sockets) {
      if (this.alive.get(ws) === false) {
        ws.terminate();
        this.sockets.delete(id);
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  private send(ws: WebSocket, msg: ToPhone): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // ── answers ──────────────────────────────────────────────────────────────
  /**
   * Accepts an answer from the phone (WebSocket or HTTPS). `bytes` is the size of the raw message.
   * Returns false if unknown/foreign. Never stringifies phone input (hostile nesting).
   */
  answer(deviceId: string, a: PhoneAnswer, bytes: number): boolean {
    const p = this.pending.get(a.id);
    if (!p || p.device.id !== deviceId || p.answer) {
      const ws = this.sockets.get(deviceId);
      if (ws) this.send(ws, { type: "ack", id: a.id, accepted: false });
      return false;
    }
    const failed = (message: string): PhoneAnswer => ({ type: "response", id: a.id, ok: false, error: { code: "INTERNAL", message } });
    if (a.ok && bytes > this.opts.maxResultBytes) {
      a = failed(`Answer too large (${Math.round(bytes / 1024)} KB). Ask for a shorter range or daily aggregation.`);
    }
    if (p.waiters.size === 0 && a.ok) {
      // nobody is waiting right now — hold it for get_pending_result, within budget
      const held = this.heldByDevice.get(deviceId) ?? 0;
      if (held + bytes > MAX_HELD_BYTES_PER_DEVICE || this.heldTotal + bytes > MAX_HELD_BYTES_TOTAL) {
        a = failed("The relay could not hold this answer until it was collected. Ask again.");
      } else {
        p.heldBytes = bytes;
        this.heldByDevice.set(deviceId, held + bytes);
        this.heldTotal += bytes;
      }
    }
    p.answer = a;
    p.answeredAt = Date.now();
    const ws = this.sockets.get(deviceId);
    if (ws) this.send(ws, { type: "ack", id: a.id, accepted: true });
    for (const w of p.waiters) w(a);
    return true;
  }

  /** Removes a pending entry and releases the memory budget it held. */
  private drop(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.heldBytes) {
      this.heldTotal -= p.heldBytes;
      const left = (this.heldByDevice.get(p.device.id) ?? 0) - p.heldBytes;
      if (left > 0) this.heldByDevice.set(p.device.id, left);
      else this.heldByDevice.delete(p.device.id);
    }
  }

  private pendingFor(deviceId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.device.id === deviceId) n++;
    return n;
  }

  // ── tool calls ───────────────────────────────────────────────────────────
  async call(input: {
    device: Device;
    connection: Connection;
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    signal?: AbortSignal;
  }): Promise<Outcome> {
    const started = Date.now();
    if (this.pendingFor(input.device.id) >= MAX_PENDING_PER_DEVICE) {
      return { status: "error", code: "INTERNAL", message: "Too many requests are waiting for this phone. Wait a minute, then call relay_status." };
    }
    const id = rid();
    const online = this.isOnline(input.device.id);
    const via: "live" | "push" = online ? "live" : "push";
    const request: ServerRequest = {
      type: "request",
      id,
      connection: { id: input.connection.id, label: input.connection.label, client_name: input.connection.client_name },
      tool: input.tool,
      args: input.args,
      summary: input.summary,
      deadline: started + this.opts.approvalWaitMs,
      via,
    };
    const p: Pending = {
      id,
      device: input.device,
      connection: input.connection,
      request,
      createdAt: started,
      expiresAt: started + this.opts.approvalWaitMs + this.opts.pendingTtlMs,
      delivered: false,
      heldBytes: 0,
      waiters: new Set(),
    };

    if (online) {
      this.pending.set(id, p);
      p.delivered = this.send(this.sockets.get(input.device.id)!, request);
    } else {
      if (!this.opts.canPush(input.device)) return { status: "offline", reason: "no_push" };
      this.pending.set(id, p);
      const pushed = await this.opts.notify(input.device, request).catch(() => false);
      if (!pushed) {
        this.drop(id);
        return { status: "offline", reason: "push_failed" };
      }
    }

    const answer = await this.waitFor(p, this.opts.approvalWaitMs, input.signal);
    if (!answer) return { status: "pending", requestId: id, via };
    this.drop(id); // delivered straight to the caller — keep nothing
    return this.toOutcome(answer, Date.now() - started);
  }

  /** For get_pending_result: same connection only; long-polls up to waitMs. */
  async collect(connectionId: string, requestId: string, waitMs: number, signal?: AbortSignal): Promise<Outcome | "unknown"> {
    const p = this.pending.get(requestId);
    if (!p || p.connection.id !== connectionId) return "unknown";
    const answer = await this.waitFor(p, waitMs, signal);
    if (!answer) return { status: "pending", requestId, via: p.request.via };
    this.drop(requestId);
    return this.toOutcome(answer, (p.answeredAt ?? Date.now()) - p.createdAt);
  }

  private waitFor(p: Pending, ms: number, signal?: AbortSignal): Promise<PhoneAnswer | undefined> {
    if (p.answer) return Promise.resolve(p.answer);
    return new Promise((resolve) => {
      const done = (a?: PhoneAnswer) => {
        clearTimeout(t);
        p.waiters.delete(done);
        signal?.removeEventListener("abort", onAbort);
        resolve(a);
      };
      const onAbort = () => done(undefined);
      const t = setTimeout(() => done(undefined), ms);
      p.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private toOutcome(a: PhoneAnswer, ms: number): Outcome {
    return a.ok ? { status: "ok", result: a.result, meta: a.meta, ms } : { status: "error", code: a.error.code, message: a.error.message };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (now > p.expiresAt) {
        this.drop(id);
        const ws = this.sockets.get(p.device.id);
        if (ws && !p.answer) this.send(ws, { type: "cancel", id, reason: "expired" });
      }
    }
  }

  /** Drops in-memory state for a device (used on device deletion). */
  forget(deviceId: string) {
    this.sockets.get(deviceId)?.close(4001, "device deleted");
    this.sockets.delete(deviceId);
    for (const [id, p] of this.pending) if (p.device.id === deviceId) this.drop(id);
  }

  close() {
    clearInterval(this.timer);
    for (const ws of this.sockets.values()) ws.close(1001, "server shutting down");
  }
}
