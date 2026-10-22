// Account-free storage. Holds ONLY: device identities, AI connections (token hashes),
// optional APNs tokens and the waitlist. Health data never reaches this file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

export type Device = {
  id: string;
  created_at: number;
  last_seen_at: number;
  apns_token: string | null;
  apns_env: string | null;
  pro_until: number | null;
};

export type Connection = {
  id: string;
  device_id: string;
  label: string;
  client_name: string | null;
  client_version: string | null;
  user_agent: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        apns_token TEXT,
        apns_env TEXT,
        pro_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        client_name TEXT,
        client_version TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS connections_device ON connections(device_id);
      CREATE TABLE IF NOT EXISTS waitlist (
        email TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ── devices ────────────────────────────────────────────────────────────
  createDevice(): { device: Device; deviceToken: string } {
    const id = randomUUID();
    const secret = token();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO devices (id, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(id, sha256(secret), now, now);
    return { device: this.getDevice(id)!, deviceToken: `${id}.${secret}` };
  }

  getDevice(id: string): Device | undefined {
    return this.db
      .prepare("SELECT id, created_at, last_seen_at, apns_token, apns_env, pro_until FROM devices WHERE id = ?")
      .get(id) as Device | undefined;
  }

  /** Resolves "<deviceId>.<secret>" to a device, or undefined. */
  authDevice(deviceToken: string | undefined): Device | undefined {
    if (!deviceToken) return;
    const dot = deviceToken.indexOf(".");
    if (dot < 1) return;
    const id = deviceToken.slice(0, dot);
    const row = this.db.prepare("SELECT secret_hash FROM devices WHERE id = ?").get(id) as
      | { secret_hash: string }
      | undefined;
    if (!row || row.secret_hash !== sha256(deviceToken.slice(dot + 1))) return;
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
    return this.getDevice(id);
  }

  setPushToken(deviceId: string, apnsToken: string | null, env: string | null) {
    this.db.prepare("UPDATE devices SET apns_token = ?, apns_env = ? WHERE id = ?").run(apnsToken, env, deviceId);
  }

  setProUntil(deviceId: string, until: number | null) {
    this.db.prepare("UPDATE devices SET pro_until = ? WHERE id = ?").run(until, deviceId);
  }

  /** Right to erasure: removes the device and every connection it owns. */
  deleteDevice(deviceId: string) {
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  }

  // ── AI connections ─────────────────────────────────────────────────────
  createConnection(deviceId: string, label: string): { connection: Connection; secret: string } {
    const id = "c_" + token(9);
    const secret = "rly_" + token();
    this.db
      .prepare("INSERT INTO connections (id, device_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, deviceId, sha256(secret), label, Date.now());
    return { connection: this.getConnection(id)!, secret };
  }

  getConnection(id: string): Connection | undefined {
    return this.db
      .prepare(
        "SELECT id, device_id, label, client_name, client_version, user_agent, created_at, last_used_at, revoked_at FROM connections WHERE id = ?",
      )
      .get(id) as Connection | undefined;
  }

  listConnections(deviceId: string): Connection[] {
    return this.db
      .prepare(
        "SELECT id, device_id, label, client_name, client_version, user_agent, created_at, last_used_at, revoked_at FROM connections WHERE device_id = ? AND revoked_at IS NULL ORDER BY created_at",
      )
      .all(deviceId) as Connection[];
  }

  authConnection(secret: string | undefined): Connection | undefined {
    if (!secret || !secret.startsWith("rly_")) return;
    const row = this.db
      .prepare(
        "SELECT id, device_id, label, client_name, client_version, user_agent, created_at, last_used_at, revoked_at FROM connections WHERE token_hash = ?",
      )
      .get(sha256(secret)) as Connection | undefined;
    if (!row || row.revoked_at) return;
    return row;
  }

  touchConnection(id: string, client?: { name?: string; version?: string; userAgent?: string }) {
    if (client?.name) {
      this.db
        .prepare(
          "UPDATE connections SET last_used_at = ?, client_name = ?, client_version = ?, user_agent = ? WHERE id = ?",
        )
        .run(Date.now(), client.name.slice(0, 80), (client.version ?? "").slice(0, 40), (client.userAgent ?? "").slice(0, 160), id);
    } else {
      this.db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
    }
  }

  /** Revoking deletes the row: nothing about a revoked AI connection is kept. */
  revokeConnection(deviceId: string, id: string): boolean {
    const r = this.db.prepare("DELETE FROM connections WHERE id = ? AND device_id = ?").run(id, deviceId);
    return Number(r.changes) > 0;
  }

  // ── waitlist ───────────────────────────────────────────────────────────
  addWaitlist(email: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)").run(email, Date.now());
    return Number(r.changes) > 0;
  }

  stats() {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      devices: one("SELECT COUNT(*) AS n FROM devices"),
      connections: one("SELECT COUNT(*) AS n FROM connections WHERE revoked_at IS NULL"),
      waitlist: one("SELECT COUNT(*) AS n FROM waitlist"),
    };
  }
}
