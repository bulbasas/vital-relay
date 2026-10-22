// End-to-end probe: acts like an AI client against a relay URL.
//   npm run probe -- <mcp_url>          (URL from the simulator / app)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: npm run probe -- <mcp_url>");
  process.exit(2);
}
const client = new Client({ name: "relay-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const show = async (name: string, args: Record<string, unknown> = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  console.log(`\n▶ ${name}(${JSON.stringify(args)}) ${r.isError ? "ERROR " : ""}${Date.now() - t0} ms\n  ${text.length > 400 ? text.slice(0, 400) + ` … (${text.length} chars)` : text}`);
  return r;
};

await show("relay_status");
await show("health_overview");
await show("get_metric_series", { metric: "hrv", granularity: "week", start: "2026-09-01", end: "2026-10-20" });
await show("get_metric_series", { metric: "steps", granularity: "raw", start: "2026-09-01", end: "2026-10-20" });
await show("list_workouts", { limit: 3 });
await show("get_sleep", {});
await show("define_metric", { name: "readiness", title: "Readiness", expression: "scale(0.5*z(hrv, 30d) - 0.3*z(resting_heart_rate, 30d) + 0.2*z(sleep_hours, 14d), -2, 2)", unit: "pts", description: "HRV up, resting HR down and good sleep vs your own baseline.", higher_is_better: true });
await show("define_metric", { name: "broken", title: "Broken", expression: "avg(steps)", description: "should fail on the relay" });
await show("compute_custom_metric", { name: "readiness" });
await show("get_pending_result", { request_id: "r_doesnotexist" });
await client.close();
