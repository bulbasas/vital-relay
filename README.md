# Vital Relay — relay server

The open-source half of **Vital Relay**: a remote [MCP](https://modelcontextprotocol.io) server that lets AI assistants
(Claude, ChatGPT, Cursor, Claude Code, any MCP client) ask about a user's Apple Health data — answered **live by the
user's iPhone**, passed through this server's memory and **never stored**.

```
AI client ──MCP (Streamable HTTP)──▶ relay (this repo, RAM only) ──WebSocket / push──▶ iPhone app (HealthKit)
```

The iPhone app is a separate, closed-source product. This repository exists so that anyone can verify what the
relay does with health data (nothing, beyond forwarding it) and run their own.

## What is stored, what is not

| | Where | What |
|---|---|---|
| ✅ stored | SQLite (`DB_PATH`) | random device id + **hash** of its secret; AI connections (label, self-reported client name, **hash** of the token, timestamps); optional APNs token; Pro expiry; landing-page waitlist emails |
| ⏳ in memory only | process RAM | open phone sockets; tool calls waiting for the phone (≤ 40 s); answers not yet collected by the AI (≤ 10 min, handed out **once**, then dropped) |
| ❌ never | — | health data on disk, tool arguments or answers in logs, accounts, names, emails of app users, analytics, third-party requests |
| 📝 logged | stdout (JSON) | method, path (MCP secrets replaced by `[secret]`), status, latency, client IP |

Health data is visible to this server in plain text while it is forwarded (TLS terminates here; the AI provider needs
plain text). That is exactly why the code is public.

## How a request flows
1. The user creates a connection in the app → gets a secret MCP URL (`/mcp/rly_…`) or bearer token for one AI.
2. The AI calls a tool, e.g. `get_sleep`. The relay validates arguments and ranges, then:
   - **app open** → forwards the call over the phone's WebSocket and waits up to 40 s;
   - **app closed + push enabled** → sends a visible notification (“Claude asks for: Sleep · last 7 nights”);
     the user approves with Face ID and the phone posts the answer;
   - otherwise → tells the AI the phone is offline.
3. The phone checks that AI's permissions, reads HealthKit, optionally shows the user the computed answer, and replies
   with a receipt id (`#a4f2`) that matches an entry in the phone's ledger.
4. If the phone is slower than 40 s, the AI gets `request_id` and collects the answer with `get_pending_result`.

## MCP tools
`health_overview` · `get_metric_series` · `list_workouts` · `get_workout` · `get_sleep` · `list_available_metrics` ·
`define_metric` · `list_custom_metrics` · `compute_custom_metric` · `delete_custom_metric` · `relay_status` ·
`get_pending_result` — schemas in [`src/tools.ts`](src/tools.ts).
Custom metrics use a small declarative formula language ([`src/formula.ts`](src/formula.ts)); no code is ever sent to
the phone.

## Run it
```bash
npm i
npm run dev                         # http://localhost:8083 (landing page + API + /mcp)
npm test                            # formula language tests
```
No iPhone? Use the simulator — it registers a device, creates a connection and answers with synthetic data:
```bash
npm run sim -- --server http://localhost:8083     # prints the MCP URL and a `claude mcp add …` command
npm run probe -- <MCP URL>                        # calls every tool like an AI client would
```

## Self-host
```bash
cp .env.example .env               # set PUBLIC_URL
docker compose up -d --build       # listens on 127.0.0.1:8083
```
Put a TLS reverse proxy in front ([`deploy/nginx.example.conf`](deploy/nginx.example.conf)). Requirements:
- **do not log** request paths under `/mcp` (they contain connection secrets);
- WebSocket upgrade for `/v1/ws`;
- read timeout ≥ 60 s for `/mcp` (tool calls may wait for the phone).

Then in the app: Settings → Relay server → your URL.

Push notifications (approve requests while the app is closed) need your own Apple Developer account, an APNs key and
your own build of the app — the hosted relay at the app's default address has them; a self-hosted relay works in live
mode (app open) out of the box.

| Env | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8083` | base URL shown in MCP URLs |
| `PORT` / `HOST` | `8083` / `0.0.0.0` | |
| `DB_PATH` | `./data/relay.sqlite` | |
| `APPROVAL_WAIT_MS` | `40000` | how long a tool call waits for the phone |
| `PENDING_TTL_MS` | `600000` | how long an uncollected answer stays in RAM |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH`, `APNS_TOPIC`, `APNS_ENV` | empty | push (optional) |
| `BRAND_NAME` | `Vital Relay` | name used in messages to the AI |

## Phone protocol
JSON over WebSocket (`GET /v1/ws`, `Authorization: Bearer <device token>`), contract in
[`src/protocol.ts`](src/protocol.ts). REST: `POST /v1/devices`, `GET|POST|DELETE /v1/connections`,
`PUT /v1/push-token`, `POST /v1/answers`, `DELETE /v1/devices/me`.

## Security
See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License
[AGPL-3.0](LICENSE). If you run a modified relay as a service, publish your changes — that keeps “nothing stored”
verifiable for everyone.
