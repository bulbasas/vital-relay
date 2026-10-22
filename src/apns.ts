// Minimal APNs client (HTTP/2 + ES256 provider token), no dependencies.
// Disabled unless APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_PATH / APNS_TOPIC are set (Phase 2).
import http2 from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Device } from "./db.ts";
import type { ServerRequest } from "./protocol.ts";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class Apns {
  private key?: KeyObject;
  private token?: { value: string; at: number };
  private sessions = new Map<string, http2.ClientHttp2Session>();
  private cfg: Config["apns"];

  constructor(cfg: Config["apns"]) {
    this.cfg = cfg;
    if (cfg.keyId && cfg.teamId && cfg.keyPath && cfg.topic) {
      this.key = createPrivateKey(readFileSync(cfg.keyPath));
    }
  }

  get enabled() {
    return !!this.key;
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now - this.token.at < 50 * 60) return this.token.value;
    const head = b64url(JSON.stringify({ alg: "ES256", kid: this.cfg.keyId }));
    const body = b64url(JSON.stringify({ iss: this.cfg.teamId, iat: now }));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: this.key!, dsaEncoding: "ieee-p1363" });
    this.token = { value: `${head}.${body}.${b64url(sig)}`, at: now };
    return this.token.value;
  }

  private session(production: boolean) {
    const host = production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    let s = this.sessions.get(host);
    if (!s || s.closed || s.destroyed) {
      s = http2.connect(host);
      s.on("error", () => this.sessions.delete(host));
      s.on("goaway", () => this.sessions.delete(host));
      s.unref();
      this.sessions.set(host, s);
    }
    return s;
  }

  send(
    deviceToken: string,
    production: boolean,
    payload: object,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; reason?: string }> {
    if (!this.key) return Promise.resolve({ ok: false, status: 0, reason: "apns disabled" });
    return new Promise((resolve) => {
      const req = this.session(production).request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        "apns-topic": this.cfg.topic,
        ...headers,
      });
      let status = 0;
      let data = "";
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = data ? JSON.parse(data).reason : undefined;
        } catch {
          /* empty */
        }
        resolve({ ok: status === 200, status, reason });
      });
      req.on("error", (e) => resolve({ ok: false, status, reason: e.message }));
      req.end(JSON.stringify(payload));
    });
  }

  /** Visible "approve this request" notification. Contains the question, never health data. */
  async notifyRequest(device: Device, r: ServerRequest, ttlMs: number): Promise<boolean> {
    if (!device.apns_token) return false;
    const who = r.connection.label || r.connection.client_name || "Your AI";
    const payload = {
      aps: {
        alert: { title: `${who} asks for your data`, body: `${r.summary} — review and send?` },
        sound: "default",
        category: "RELAY_REQUEST",
        "thread-id": r.connection.id,
        "interruption-level": "time-sensitive",
        "mutable-content": 1,
      },
      rid: r.id,
      tool: r.tool,
      args: r.args,
      conn: { id: r.connection.id, label: r.connection.label },
    };
    const res = await this.send(device.apns_token, device.apns_env === "production", payload, {
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor((Date.now() + ttlMs) / 1000)),
      "apns-collapse-id": r.id,
    });
    return res.ok;
  }

  close() {
    for (const s of this.sessions.values()) s.close();
  }
}
