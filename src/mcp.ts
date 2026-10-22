// Remote MCP endpoint (Streamable HTTP, stateless). Every request builds a tiny McpServer
// bound to one AI connection; tool calls are forwarded to that connection's phone.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import type { Connection, Device, Store } from "./db.ts";
import type { Hub, Outcome } from "./hub.ts";
import { TOOLS, checkRange, describeRequest } from "./tools.ts";
import { FormulaError, parse } from "./formula.ts";
import { Limiter } from "./api.ts";

export const BRAND = process.env.BRAND_NAME ?? "Vital Relay";

const INSTRUCTIONS = `${BRAND} reads the user's Apple Health data live from their iPhone. Nothing is stored on the relay.
- Start with health_overview: it also tells you today's date and the user's time zone.
- Prefer daily aggregates; ask for raw samples only for short ranges.
- If a request is pending approval on the phone, tell the user to check their iPhone, then call get_pending_result.
- Every answer carries a receipt id (e.g. #a4f2) that the user can find in the app's ledger — mention it when you cite numbers.
- This is wellness data, not a medical device. Encourage professional advice for medical concerns.`;

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], isError });

function render(outcome: Outcome, label: string): CallToolResult {
  switch (outcome.status) {
    case "ok":
      return outcome.result as CallToolResult;
    case "error": {
      const hints: Record<string, string> = {
        DENIED: "The user declined, or their permissions for this AI block this data. Do not retry; ask whether they want to allow it in the app.",
        NOT_AUTHORIZED: "Apple Health has not shared this data type with the app. The user can enable it in Settings → Health → Data Access & Devices.",
        LOCKED: "The iPhone is locked, so Apple Health data is encrypted. Ask the user to unlock the phone and try again.",
        UNSUPPORTED: "The app on the phone does not support this tool yet. Ask the user to update the app.",
        INVALID_ARGS: "The phone rejected the arguments.",
        NO_DATA: "There is no data for this request.",
        INTERNAL: "The phone failed to answer.",
      };
      return text(`${outcome.code}: ${outcome.message}\n${hints[outcome.code] ?? ""}`.trim(), outcome.code !== "NO_DATA");
    }
    case "pending":
      return text(
        `Waiting for the user to approve this on their iPhone (request_id: ${outcome.requestId}). ` +
          `Tell the user to check their phone, then call get_pending_result with request_id "${outcome.requestId}". ` +
          `The answer is held in memory for 10 minutes.`,
      );
    case "offline":
      return text(
        outcome.reason === "push_failed"
          ? `The user's iPhone could not be reached (notification failed). Ask them to open the ${BRAND} app — it answers while open.`
          : `The user's iPhone relay is offline. Ask them to open the ${BRAND} app and keep it on screen (live mode), then try again. ` +
              `With ${BRAND} Pro, requests arrive as notifications to approve while the app is closed.`,
        true,
      );
  }
}

function buildServer(ctx: { store: Store; hub: Hub; config: Config; connection: Connection; device: Device }) {
  const server = new McpServer(
    { name: "vital-relay", title: BRAND, version: ctx.config.version, websiteUrl: ctx.config.publicUrl },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );

  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      async (args: Record<string, unknown>, extra) => {
        if (def.name === "relay_status") return relayStatus(ctx);
        if (def.name === "get_pending_result") {
          const r = await ctx.hub.collect(ctx.connection.id, String(args.request_id), 25_000, extra.signal);
          if (r === "unknown") return text("Unknown or expired request_id. Ask the question again.", true);
          return render(r, ctx.connection.label);
        }
        const bad = checkRange(def, args);
        if (bad) return text(bad, true);
        if (def.name === "define_metric") {
          // syntax errors come back instantly, without bothering the phone
          try {
            parse(String(args.expression), "any");
          } catch (e) {
            if (e instanceof FormulaError) return text(`Formula error: ${e.message}`, true);
            throw e;
          }
        }
        const outcome = await ctx.hub.call({
          device: ctx.device,
          connection: ctx.connection,
          tool: def.name,
          args,
          summary: describeRequest(def.name, args),
          signal: extra.signal,
        });
        return render(outcome, ctx.connection.label);
      },
    );
  }
  return server;
}

function relayStatus(ctx: { hub: Hub; device: Device; connection: Connection; config: Config }): CallToolResult {
  const live = ctx.hub.isOnline(ctx.device.id);
  const canNotify = !!ctx.device.apns_token && (ctx.config.devPushForAll || (ctx.device.pro_until ?? 0) > Date.now());
  const mode = live ? "live" : canNotify ? "notify" : "offline";
  const status = {
    mode,
    phone_last_seen: new Date(ctx.device.last_seen_at).toISOString(),
    connection: ctx.connection.label,
    advice:
      mode === "live"
        ? "The app is open — requests are answered immediately."
        : mode === "notify"
          ? "The app is closed — each request sends a notification; the user approves with Face ID."
          : `Ask the user to open the ${BRAND} app.`,
  };
  return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
}

/** Finds an initialize request (possibly inside a JSON-RPC batch) to learn the client's self-reported name. */
function clientInfoOf(body: unknown): { name?: string; version?: string } | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (m && typeof m === "object" && (m as { method?: string }).method === "initialize") {
      const ci = (m as { params?: { clientInfo?: { name?: string; version?: string } } }).params?.clientInfo;
      if (ci) return { name: String(ci.name ?? ""), version: String(ci.version ?? "") };
    }
  }
}

export function registerMcp(app: FastifyInstance, deps: { store: Store; hub: Hub; config: Config }) {
  // a leaked URL must not be able to flood the phone: 120 MCP requests per minute per connection
  const perConnection = new Limiter(120, 60_000);
  const handle = async (req: FastifyRequest, reply: FastifyReply, secret: string | undefined) => {
    const connection = deps.store.authConnection(secret);
    if (!connection) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer error="invalid_token"')
        .send({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or revoked connection. Create a new one in the app." }, id: null });
    }
    if (Array.isArray(req.body)) {
      // batching was removed from MCP; accepting it would let one HTTP request carry 100 tool calls
      return reply.code(400).send({ jsonrpc: "2.0", error: { code: -32600, message: "Batch requests are not supported." }, id: null });
    }
    if (!perConnection.take(connection.id)) {
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ jsonrpc: "2.0", error: { code: -32002, message: "Too many requests for this connection — slow down." }, id: null });
    }
    const device = deps.store.getDevice(connection.device_id);
    if (!device) return reply.code(401).send({ jsonrpc: "2.0", error: { code: -32001, message: "Device removed." }, id: null });

    const ci = clientInfoOf(req.body);
    deps.store.touchConnection(connection.id, ci ? { ...ci, userAgent: String(req.headers["user-agent"] ?? "") } : undefined);
    // re-read so the phone sees the fresh client name on the very first call
    const fresh = ci ? (deps.store.getConnection(connection.id) ?? connection) : connection;

    const server = buildServer({ ...deps, connection: fresh, device });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  };

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
  };
  const notAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });

  // secret-in-path: works in every client that only takes a URL (Claude.ai, ChatGPT)
  app.post<{ Params: { secret: string } }>("/mcp/:secret", (req, reply) => handle(req, reply, req.params.secret));
  // bearer header: Claude Code, Cursor and (later) OAuth access tokens
  app.post("/mcp", (req, reply) => handle(req, reply, bearer(req)));
  for (const path of ["/mcp", "/mcp/:secret"]) {
    app.get(path, notAllowed);
    app.delete(path, notAllowed);
  }
}
