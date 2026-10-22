// Simulated iPhone: registers a device, creates an AI connection, keeps the live WebSocket
// open and answers tool calls with synthetic (deterministic) health data. Its answers are the
// reference output format for the iOS app (HealthKitQueryExecutor.swift).
//
//   npm run sim -- --server http://localhost:8083            first run creates .sim-device.json
//   npm run sim -- --server https://pulse.impulsera.lt --label "Claude" --new-connection
//   options: --deny hrv_sdnn,heart_rate   --approve-delay 3000   --state .sim-other.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { METRICS, type MetricId } from "../src/tools.ts";
import { evaluate, parse, inputs, FormulaError } from "../src/formula.ts";
import type { PhoneAnswer, ServerRequest, ToPhone } from "../src/protocol.ts";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (name: string) => argv.includes(`--${name}`);
const SERVER = (opt("server", "http://localhost:8083") as string).replace(/\/+$/, "");
const STATE = opt("state", ".sim-device.json") as string;
const LABEL = opt("label", "Claude") as string;
const DENY = new Set((opt("deny", "") as string).split(",").filter(Boolean));
const APPROVE_DELAY = Number(opt("approve-delay", "0"));

type State = { server: string; device_token: string; connections: { id: string; label: string; mcp_url: string; bearer_token: string }[] };

async function http<T>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(tokenOverride ? { authorization: `Bearer ${tokenOverride}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function loadState(): Promise<State> {
  let st: State | undefined;
  if (existsSync(STATE)) {
    st = JSON.parse(readFileSync(STATE, "utf8")) as State;
    if (st.server !== SERVER) st = undefined;
  }
  if (!st) {
    const r = await http<{ device_token: string }>("POST", "/v1/devices", {});
    st = { server: SERVER, device_token: r.device_token, connections: [] };
    console.log("✓ registered a new simulated device");
  }
  if (!st.connections.length || flag("new-connection")) {
    const c = await http<State["connections"][number]>("POST", "/v1/connections", { label: LABEL }, st.device_token);
    st.connections.push({ id: c.id, label: c.label, mcp_url: c.mcp_url, bearer_token: c.bearer_token });
    console.log(`✓ created connection "${c.label}"`);
  }
  writeFileSync(STATE, JSON.stringify(st, null, 2));
  return st;
}

// ── synthetic body: a 34-year-old recreational runner ─────────────────────
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + "T12:00:00Z") + n * 86_400_000));
const today = () => iso(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000));
const round = (v: number, p = 1) => Math.round(v * 10 ** p) / 10 ** p;

type Day = Record<string, number> & { workout: number };
const dayCache = new Map<string, Day>();
function day(date: string): Day {
  const hit = dayCache.get(date);
  if (hit) return hit;
  const r = rng(date);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const workout = [2, 4, 6].includes(dow) ? 1 : dow === 0 && r() > 0.5 ? 1 : 0;
  const fatigue = Math.sin(Date.parse(date) / 86_400_000 / 9) * 0.6 + gauss(r) * 0.4; // slow cycles
  const sleep = Math.min(9.2, Math.max(4.8, 7.1 - fatigue * 0.5 + gauss(r) * 0.55));
  const d: Day = {
    workout,
    steps: Math.round(Math.max(1500, 8200 + workout * 5200 + gauss(r) * 2400)),
    active_energy: Math.round(420 + workout * 480 + gauss(r) * 110),
    basal_energy: Math.round(1690 + gauss(r) * 25),
    exercise_minutes: Math.round(Math.max(3, 18 + workout * 46 + gauss(r) * 9)),
    stand_hours: Math.round(Math.min(16, Math.max(5, 11 + gauss(r) * 2))),
    distance_walking_running: round(Math.max(1, 5.9 + workout * 8.2 + gauss(r) * 1.8), 2),
    flights_climbed: Math.max(0, Math.round(9 + gauss(r) * 5)),
    resting_heart_rate: Math.round(52 + fatigue * 2.4 + gauss(r) * 1.4),
    walking_heart_rate_average: Math.round(98 + fatigue * 3 + gauss(r) * 3),
    hrv_sdnn: Math.round(Math.max(18, 56 - fatigue * 9 + gauss(r) * 7)),
    hrv: 0, // filled below: the iPhone's native HRV is SDNN
    heart_rate: Math.round(71 + workout * 9 + gauss(r) * 4),
    vo2max: round(48.6 + gauss(r) * 0.25),
    respiratory_rate: round(14.2 + fatigue * 0.3 + gauss(r) * 0.4),
    oxygen_saturation: round(97 + gauss(r) * 0.8),
    wrist_temperature: round(34.6 + fatigue * 0.12 + gauss(r) * 0.1, 2),
    body_mass: round(74.2 + Math.sin(Date.parse(date) / 86_400_000 / 30) * 0.6 + gauss(r) * 0.25),
    sleep_hours: round(sleep, 2),
    sleep_efficiency: round(Math.min(98, 91 - fatigue * 2 + gauss(r) * 2)),
    time_in_daylight: Math.round(Math.max(0, 48 + workout * 35 + gauss(r) * 20)),
    mindful_minutes: r() > 0.6 ? Math.round(5 + r() * 15) : 0,
    walking_speed: round(5.2 + gauss(r) * 0.2),
    running_speed: round(11.4 + gauss(r) * 0.4),
    running_power: Math.round(255 + gauss(r) * 12),
    heart_rate_recovery: Math.round(31 + gauss(r) * 3),
    water: round(Math.max(0.6, 2.1 + gauss(r) * 0.5)),
    caffeine: Math.round(Math.max(0, 160 + gauss(r) * 70)),
  };
  d.hrv = d.hrv_sdnn;
  dayCache.set(date, d);
  return d;
}
const NO_DATA = new Set(["hrv_rmssd", "blood_pressure_systolic", "blood_pressure_diastolic", "blood_glucose", "distance_swimming", "dietary_energy", "dietary_protein", "dietary_carbohydrates", "dietary_fat", "body_fat_percentage", "lean_body_mass", "bmi", "distance_cycling"]);
const CUMULATIVE = new Set(["steps", "active_energy", "basal_energy", "exercise_minutes", "stand_hours", "distance_walking_running", "flights_climbed", "time_in_daylight", "mindful_minutes", "water", "caffeine"]);

function metricValue(m: string, date: string): number | undefined {
  if (date > today() || NO_DATA.has(m) || DENY.has(m)) return undefined;
  const d = day(date);
  if (m in custom) return computeCustom(m, date);
  let v = d[m];
  if (v === undefined) return undefined;
  if (date === today() && CUMULATIVE.has(m)) v = round(v * Math.min(1, new Date().getHours() / 21), 1); // the day isn't over
  return v;
}

function workoutsOn(date: string) {
  const d = day(date);
  if (!d.workout) return [];
  const r = rng("w" + date);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const type = dow === 6 ? "running" : dow === 4 ? "strength_training" : "running";
  const mins = type === "running" ? Math.round(dow === 6 ? 70 + r() * 25 : 38 + r() * 14) : Math.round(45 + r() * 15);
  const km = type === "running" ? round((mins / 60) * (10.6 + r() * 1.4), 2) : undefined;
  const avg = type === "running" ? Math.round(146 + r() * 10) : Math.round(118 + r() * 10);
  const z = type === "running" ? [0.04, 0.22, 0.46, 0.24, 0.04] : [0.25, 0.4, 0.25, 0.08, 0.02];
  return [
    {
      id: `w_${date.replace(/-/g, "")}_1`,
      type,
      start: `${date}T${type === "running" ? "07:12" : "18:30"}:00`,
      duration_min: mins,
      distance_km: km,
      active_energy_kcal: Math.round(mins * (type === "running" ? 11.2 : 6.4)),
      avg_hr: avg,
      max_hr: avg + Math.round(18 + r() * 10),
      hr_zone_minutes: z.map((f) => Math.round(f * mins)),
      source: "Apple Watch",
    },
  ];
}

// ── custom metrics (Pulse Lab) ────────────────────────────────────────────
type Custom = { name: string; title: string; expression: string; unit?: string; description: string; higher_is_better?: boolean };
const custom: Record<string, Custom> = {};
function computeCustom(name: string, date: string, depth = 0): number | undefined {
  const c = custom[name];
  if (!c || depth > 4) return undefined;
  const tree = parse(c.expression, Object.keys(custom));
  const v = evaluate(tree, (m, off) => (m in custom ? computeCustom(m, addDays(date, -off), depth + 1) : metricValue(m, addDays(date, -off))));
  return v === undefined ? undefined : round(v, 2);
}

// ── tools ─────────────────────────────────────────────────────────────────
const receipt = () => randomBytes(2).toString("hex");
type Out = { data: Record<string, unknown>; types: string[]; samples: number };

function range(args: Record<string, unknown>) {
  const end = (args.end as string) ?? today();
  const start = (args.start as string) ?? addDays(end, -6);
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 400; d = addDays(d, 1)) days.push(d);
  return { start, end, days };
}

function sleepNight(date: string) {
  const d = day(date);
  const asleep = d.sleep_hours;
  const r = rng("s" + date);
  const bed = 22.8 + r() * 1.2;
  const fmt = (h: number) => `${String(Math.floor(h % 24)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;
  return {
    night_of: addDays(date, -1),
    bedtime: fmt(bed),
    wake_time: fmt(bed + asleep / (d.sleep_efficiency / 100)),
    in_bed_h: round(asleep / (d.sleep_efficiency / 100), 2),
    asleep_h: asleep,
    efficiency_pct: Math.round(d.sleep_efficiency),
    stages_h: { core: round(asleep * 0.54, 2), deep: round(asleep * 0.15, 2), rem: round(asleep * 0.23, 2), awake: round(asleep * 0.08, 2) },
    sleeping_hr: d.resting_heart_rate - 3,
    sleeping_hrv_ms: d.hrv_sdnn + 6,
    respiratory_rate: d.respiratory_rate,
  };
}

function handle(tool: string, args: Record<string, unknown>): Out {
  switch (tool) {
    case "health_overview": {
      const date = (args.date as string) ?? today();
      const d = day(date);
      const base = (m: string) => {
        const xs = [1, 2, 3, 4, 5, 6, 7].map((o) => metricValue(m, addDays(date, -o))).filter((v): v is number => v !== undefined);
        return xs.length ? round(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
      };
      return {
        types: ["steps", "activeEnergy", "restingHeartRate", "heartRateVariabilitySDNN", "sleepAnalysis", "workouts"],
        samples: 412,
        data: {
          date,
          today: today(),
          timezone: TZ,
          freshness: { watch_last_sync: new Date(Date.now() - 7 * 60_000).toISOString(), note: "Cumulative values for today are partial." },
          activity: {
            steps: metricValue("steps", date),
            active_energy_kcal: metricValue("active_energy", date),
            exercise_min: metricValue("exercise_minutes", date),
            stand_hours: metricValue("stand_hours", date),
            distance_km: metricValue("distance_walking_running", date),
          },
          heart: { resting_hr: d.resting_heart_rate, hrv_ms: d.hrv, hrv_method: "sdnn", walking_hr_avg: d.walking_heart_rate_average, vo2max: d.vo2max },
          sleep_last_night: DENY.has("sleep_hours") ? "not shared with this AI" : sleepNight(date),
          workouts: workoutsOn(date),
          baseline_7d: {
            steps: base("steps"),
            resting_hr: base("resting_heart_rate"),
            hrv_ms: base("hrv"),
            sleep_h: base("sleep_hours"),
            active_energy_kcal: base("active_energy"),
          },
          custom_metrics: Object.keys(custom).map((n) => ({ name: n, title: custom[n].title, value: computeCustom(n, date), unit: custom[n].unit })),
        },
      };
    }
    case "get_metric_series": {
      const m = args.metric as MetricId;
      const g = (args.granularity as string) ?? "day";
      const { start, end, days } = range(args);
      if (DENY.has(m)) throw Object.assign(new Error(`${m} is not shared with this AI`), { code: "DENIED" });
      if (NO_DATA.has(m)) return { types: [m], samples: 0, data: { metric: m, unit: METRICS[m], start, end, points: [], note: "No data recorded for this metric." } };
      let points: unknown[];
      if (g === "raw" || g === "hour") {
        points = days.flatMap((dd) =>
          Array.from({ length: 24 }, (_, h) => {
            const r = rng(m + dd + h);
            const v = metricValue(m, dd);
            if (v === undefined) return null;
            const val = CUMULATIVE.has(m) ? round((v / 16) * (h >= 7 && h <= 22 ? 1 : 0.05) * (0.5 + r()), 1) : round(v * (0.92 + r() * 0.16), 1);
            return { t: `${dd}T${String(h).padStart(2, "0")}:00`, value: val };
          }).filter(Boolean),
        );
      } else {
        const buckets = new Map<string, number[]>();
        for (const dd of days) {
          const v = metricValue(m, dd);
          if (v === undefined) continue;
          const key = g === "week" ? addDays(dd, -((new Date(dd + "T12:00:00Z").getUTCDay() + 6) % 7)) : g === "month" ? dd.slice(0, 7) : dd;
          buckets.set(key, [...(buckets.get(key) ?? []), v]);
        }
        points = [...buckets].map(([k, xs]) =>
          CUMULATIVE.has(m)
            ? { [g === "day" ? "date" : g]: k, total: round(xs.reduce((s, v) => s + v, 0)), ...(g === "day" ? {} : { daily_avg: round(xs.reduce((s, v) => s + v, 0) / xs.length) }) }
            : { [g === "day" ? "date" : g]: k, avg: round(xs.reduce((s, v) => s + v, 0) / xs.length), min: Math.min(...xs), max: Math.max(...xs) },
        );
      }
      const method = m === "hrv" || m === "hrv_sdnn" ? { method: "sdnn" } : {};
      return { types: [m], samples: points.length * (g === "day" ? 30 : 1), data: { metric: m, unit: METRICS[m], ...method, granularity: g, start, end, points } };
    }
    case "list_workouts": {
      const { start, end, days } = range(args);
      const t = args.activity_type as string | undefined;
      const list = days.flatMap(workoutsOn).filter((w) => !t || w.type === t).reverse().slice(0, Number(args.limit ?? 20));
      return { types: ["workouts", "heartRate"], samples: list.length, data: { start, end, count: list.length, workouts: list } };
    }
    case "get_workout": {
      const id = String(args.workout_id);
      const m = id.match(/^w_(\d{4})(\d{2})(\d{2})_1$/);
      const w = m ? workoutsOn(`${m[1]}-${m[2]}-${m[3]}`)[0] : undefined;
      if (!w) throw Object.assign(new Error("No workout with that id"), { code: "NO_DATA" });
      const r = rng("hr" + id);
      const hr = Array.from({ length: w.duration_min }, (_, i) => Math.round(w.avg_hr - 22 * Math.exp(-i / 4) + Math.sin(i / 5) * 6 + (r() - 0.5) * 4));
      const splits = w.distance_km ? Array.from({ length: Math.floor(w.distance_km) }, (_, i) => ({ km: i + 1, pace: `${5 + Math.floor(r() * 0.6)}:${String(Math.floor(r() * 60)).padStart(2, "0")}`, avg_hr: hr[Math.min(hr.length - 1, Math.round(((i + 1) / w.distance_km!) * hr.length) - 1)] })) : [];
      return { types: ["workouts", "heartRate"], samples: hr.length, data: { ...w, hr_per_minute: hr, splits, elevation_gain_m: w.distance_km ? Math.round(w.distance_km * 6) : undefined, route: "not included (privacy)" } };
    }
    case "get_sleep": {
      if (DENY.has("sleep_hours")) throw Object.assign(new Error("Sleep is not shared with this AI"), { code: "DENIED" });
      const { start, end, days } = range(args);
      return { types: ["sleepAnalysis", "heartRate", "heartRateVariabilitySDNN", "respiratoryRate"], samples: days.length * 60, data: { start, end, nights: days.filter((d) => d <= today()).map(sleepNight) } };
    }
    case "list_available_metrics": {
      const metrics = Object.entries(METRICS).map(([id, unit]) => ({
        id,
        unit,
        shared: !DENY.has(id),
        latest: NO_DATA.has(id) || DENY.has(id) ? null : today(),
      }));
      return { types: [], samples: 0, data: { metrics, custom_metrics: Object.values(custom) } };
    }
    case "define_metric": {
      const c = args as unknown as Custom;
      try {
        const tree = parse(c.expression, Object.keys(custom).filter((n) => n !== c.name));
        const missing = [...inputs(tree)].filter((m) => DENY.has(m));
        if (missing.length) throw Object.assign(new Error(`uses metrics not shared with this AI: ${missing.join(", ")}`), { code: "DENIED" });
      } catch (e) {
        if (e instanceof FormulaError) throw Object.assign(new Error(e.message), { code: "INVALID_ARGS" });
        throw e;
      }
      custom[c.name] = c;
      const last7 = Array.from({ length: 7 }, (_, i) => addDays(today(), -6 + i)).map((d) => ({ date: d, value: computeCustom(c.name, d) }));
      return { types: [...inputs(parse(c.expression, Object.keys(custom)))], samples: 7, data: { saved: true, approved_by_user: true, metric: c, last_7_days: last7 } };
    }
    case "list_custom_metrics":
      return { types: [], samples: 0, data: { metrics: Object.values(custom).map((c) => ({ ...c, today: computeCustom(c.name, today()) })) } };
    case "compute_custom_metric": {
      const name = String(args.name);
      if (!custom[name]) throw Object.assign(new Error(`No custom metric '${name}'`), { code: "NO_DATA" });
      const { start, end, days } = range(args);
      return { types: [...inputs(parse(custom[name].expression, Object.keys(custom)))], samples: days.length, data: { name, start, end, points: days.map((d) => ({ date: d, value: computeCustom(name, d) })) } };
    }
    case "delete_custom_metric": {
      const existed = delete custom[String(args.name)];
      return { types: [], samples: 0, data: { deleted: existed } };
    }
  }
  throw Object.assign(new Error(`Tool ${tool} is not implemented by this app version`), { code: "UNSUPPORTED" });
}

function answer(req: ServerRequest): PhoneAnswer {
  try {
    const out = handle(req.tool, req.args);
    const rc = receipt();
    const data = { receipt: `#${rc}`, ...out.data };
    return {
      type: "response",
      id: req.id,
      ok: true,
      result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data },
      meta: { receipt: rc, types: out.types, samples: out.samples, aggregated: req.args.granularity !== "raw" },
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { type: "response", id: req.id, ok: false, error: { code: (err.code as never) ?? "INTERNAL", message: err.message } };
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const st = await loadState();
console.log(`\nSimulated iPhone → ${SERVER}`);
for (const c of st.connections) {
  console.log(`  ${c.label.padEnd(10)} MCP URL:   ${c.mcp_url}`);
  console.log(`  ${"".padEnd(10)} Claude Code: claude mcp add --transport http ${c.label.toLowerCase().replace(/\W+/g, "-")}-health ${SERVER}/mcp --header "Authorization: Bearer ${c.bearer_token}"`);
}
console.log("");

let backoff = 1000;
function connect() {
  const ws = new WebSocket(SERVER.replace(/^http/, "ws") + "/v1/ws", { headers: { authorization: `Bearer ${st.device_token}` } });
  ws.on("open", () => {
    backoff = 1000;
    ws.send(JSON.stringify({ type: "hello", protocol: 1, app_version: "sim-0.1", platform: "simulator" }));
  });
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString()) as ToPhone;
    if (msg.type === "hello") console.log(`● live — relay ${msg.server_version}, protocol ${msg.protocol}`);
    if (msg.type === "request") {
      const t0 = Date.now();
      if (APPROVE_DELAY) await new Promise((r) => setTimeout(r, APPROVE_DELAY));
      const a = answer(msg);
      ws.send(JSON.stringify(a));
      const bytes = Buffer.byteLength(JSON.stringify(a));
      const who = msg.connection.client_name ? `${msg.connection.label} (${msg.connection.client_name})` : msg.connection.label;
      const time = new Date().toTimeString().slice(0, 8);
      console.log(
        a.ok
          ? `${time}  ${who.padEnd(26)} ${msg.tool}(${JSON.stringify(msg.args)})  → ${(bytes / 1024).toFixed(1)} kB · ${a.meta?.samples} samples · receipt #${a.meta?.receipt} · ${Date.now() - t0} ms`
          : `${time}  ${who.padEnd(26)} ${msg.tool}  ✕ ${a.error.code}: ${a.error.message}`,
      );
    }
    if (msg.type === "cancel") console.log(`  request ${msg.id} cancelled (${msg.reason})`);
  });
  ws.on("close", (code, reason) => {
    console.log(`○ offline (${code} ${reason}) — reconnecting in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  ws.on("error", (e) => console.log(`  socket error: ${e.message}`));
}
connect();
