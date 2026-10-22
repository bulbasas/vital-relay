// Wire contract between the relay and the phone (WebSocket JSON, and HTTPS for
// answers sent from a notification action). The iOS app mirrors these types in
// RelayProtocol.swift — keep both in sync and bump PROTOCOL_VERSION on breaking changes.

export const PROTOCOL_VERSION = 1;

export type TextContent = { type: "text"; text: string };

export type ToolResult = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** What the phone reports about an answer, shown in the server log as metadata only. */
export type ResponseMeta = {
  receipt?: string; // ledger entry id on the phone, e.g. "a4f2"
  types?: string[]; // HealthKit types read
  samples?: number;
  aggregated?: boolean;
};

export type ErrorCode =
  | "DENIED" // user or a permission rule said no
  | "NOT_AUTHORIZED" // HealthKit permission missing for that type
  | "LOCKED" // device locked, HealthKit store encrypted
  | "UNSUPPORTED" // tool not implemented by this app version
  | "INVALID_ARGS"
  | "NO_DATA"
  | "INTERNAL";

export type RequestConnection = {
  id: string;
  label: string;
  client_name: string | null; // self-reported by the AI client — display as "identifies as"
};

// ── server → phone ─────────────────────────────────────────────────────────
export type ServerHello = {
  type: "hello";
  protocol: number;
  device_id: string;
  server_time: string;
  server_version: string;
};

export type ServerRequest = {
  type: "request";
  id: string;
  connection: RequestConnection;
  tool: string;
  args: Record<string, unknown>;
  summary: string; // human readable, e.g. "Sleep · last 7 nights"
  deadline: number; // epoch ms after which the AI no longer waits
  via: "live" | "push";
};

export type ServerCancel = { type: "cancel"; id: string; reason: string };
export type ServerAck = { type: "ack"; id: string; accepted: boolean };

export type ToPhone = ServerHello | ServerRequest | ServerCancel | ServerAck;

// ── phone → server ─────────────────────────────────────────────────────────
export type PhoneHello = {
  type: "hello";
  protocol: number;
  app_version: string;
  platform: "ios" | "simulator";
  tools?: string[];
};

export type PhoneAnswer =
  | { type: "response"; id: string; ok: true; result: ToolResult; meta?: ResponseMeta }
  | { type: "response"; id: string; ok: false; error: { code: ErrorCode; message: string } };

export type FromPhone = PhoneHello | PhoneAnswer;

/** True when no value is nested deeper than `max` (iterative — safe on hostile input). */
export function depthWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d >= max) return false;
    for (const child of Object.values(v as object)) stack.push([child, d + 1]);
  }
  return true;
}

export function isPhoneAnswer(m: unknown): m is PhoneAnswer {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (o.type !== "response" || typeof o.id !== "string" || o.id.length > 40 || typeof o.ok !== "boolean") return false;
  if (o.ok) {
    const r = o.result as Record<string, unknown> | undefined;
    if (!r || !Array.isArray(r.content) || r.content.length > 20) return false;
    const textOnly = r.content.every(
      (c) => !!c && typeof c === "object" && (c as TextContent).type === "text" && typeof (c as TextContent).text === "string",
    );
    return textOnly && depthWithin(r.structuredContent ?? null, 32) && depthWithin(o.meta ?? null, 4);
  }
  const e = o.error as Record<string, unknown> | undefined;
  return !!e && typeof e.code === "string" && typeof e.message === "string";
}
