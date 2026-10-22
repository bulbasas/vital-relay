// MCP tool catalogue. The relay owns the schemas (so AI clients see the tools even when
// the phone is offline); the phone owns the implementation. Server-side tools are marked.
import { z } from "zod";

export const METRICS = {
  steps: "count",
  active_energy: "kcal",
  basal_energy: "kcal",
  exercise_minutes: "min",
  stand_hours: "h",
  distance_walking_running: "km",
  distance_cycling: "km",
  distance_swimming: "m",
  flights_climbed: "count",
  heart_rate: "bpm",
  resting_heart_rate: "bpm",
  walking_heart_rate_average: "bpm",
  hrv: "ms", // the phone's native HRV: iPhone = SDNN, Android = RMSSD (answers carry `method`)
  hrv_sdnn: "ms", // iPhone only
  hrv_rmssd: "ms", // Android only
  heart_rate_recovery: "bpm",
  vo2max: "ml/kg/min",
  respiratory_rate: "breaths/min",
  oxygen_saturation: "%",
  wrist_temperature: "°C",
  body_mass: "kg",
  body_fat_percentage: "%",
  lean_body_mass: "kg",
  bmi: "kg/m²",
  blood_pressure_systolic: "mmHg",
  blood_pressure_diastolic: "mmHg",
  blood_glucose: "mmol/L",
  walking_speed: "km/h",
  running_speed: "km/h",
  running_power: "W",
  time_in_daylight: "min",
  mindful_minutes: "min",
  sleep_hours: "h",
  sleep_efficiency: "%",
  dietary_energy: "kcal",
  dietary_protein: "g",
  dietary_carbohydrates: "g",
  dietary_fat: "g",
  water: "L",
  caffeine: "mg",
} as const;

export type MetricId = keyof typeof METRICS;
const metricIds = Object.keys(METRICS) as [MetricId, ...MetricId[]];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD (the user's local calendar date)");

const range = {
  start: isoDate.optional().describe("First day, YYYY-MM-DD in the user's local time. Default: 6 days before end."),
  end: isoDate.optional().describe("Last day (inclusive), YYYY-MM-DD. Default: today."),
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: Record<string, boolean | string>;
  /** Handled by the relay itself instead of being forwarded to the phone. */
  serverSide?: boolean;
  /** Max days between start and end for this tool (guards the phone). */
  maxDays?: number;
};

export const TOOLS: ToolDef[] = [
  {
    name: "health_overview",
    title: "Health overview",
    description:
      "Snapshot of one day from the user's phone (default: today): activity, resting heart rate, HRV, last night's sleep, workouts, plus 7-day baselines to compare against. Also returns today's date, the user's time zone and data freshness (when the Apple Watch last synced). Start here for open questions like 'how am I doing?' or 'why am I tired?'.",
    inputSchema: { date: isoDate.optional().describe("Day to summarise, YYYY-MM-DD. Default: today.") },
    annotations: { ...READ, title: "Health overview" },
  },
  {
    name: "get_metric_series",
    title: "Metric time series",
    description:
      "Time series for one health metric from the user's phone (Apple Health on iPhone, Health Connect on Android — the available set depends on the platform; use list_available_metrics). 'hrv' is the phone's native heart-rate variability (iPhone: SDNN, Android: RMSSD — see the `method` field; don't compare values across methods). Prefer granularity 'day' (sum for cumulative metrics such as steps, average/min/max for heart rate and similar). 'hour' allows up to 14 days, 'raw' individual samples up to 3 days and only if the user allows raw access. Call list_available_metrics if unsure a metric has data.",
    inputSchema: {
      metric: z.enum(metricIds).describe("Metric id."),
      ...range,
      granularity: z.enum(["day", "week", "month", "hour", "raw"]).default("day"),
    },
    annotations: { ...READ, title: "Metric time series" },
    maxDays: 400,
  },
  {
    name: "list_workouts",
    title: "List workouts",
    description:
      "Workouts in a date range: type, start time, duration, distance, active energy, average/max heart rate and minutes in each heart-rate zone. Use get_workout for splits and per-minute heart rate.",
    inputSchema: {
      ...range,
      activity_type: z.string().max(40).optional().describe("Filter, e.g. running, cycling, strength_training, swimming, walking, yoga, hiit."),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { ...READ, title: "List workouts" },
    maxDays: 400,
  },
  {
    name: "get_workout",
    title: "Workout detail",
    description:
      "One workout in detail: splits, heart-rate zones, per-minute heart rate, elevation, cadence and power when recorded. GPS routes are never included.",
    inputSchema: { workout_id: z.string().min(1).max(80).describe("Id from list_workouts.") },
    annotations: { ...READ, title: "Workout detail" },
  },
  {
    name: "get_sleep",
    title: "Sleep",
    description:
      "Sleep per night: bedtime, wake time, time in bed and asleep, stages (core, deep, REM, awake), plus sleeping heart rate, HRV, respiratory rate and wrist temperature when available.",
    inputSchema: { ...range },
    annotations: { ...READ, title: "Sleep" },
    maxDays: 120,
  },
  {
    name: "list_available_metrics",
    title: "Available metrics",
    description:
      "Which metrics this AI is allowed to read and which have data, with the date of the latest sample. Also lists the user's custom metrics.",
    inputSchema: {},
    annotations: { ...READ, title: "Available metrics" },
  },
  {
    name: "define_metric",
    title: "Create a custom metric",
    description:
      "Create or update a personal metric that the user's phone computes on device every day and shows as a card (and widget). 'expression' is a small formula language — numbers, + - * /, parentheses and these functions: today(m), last(m), avg(m, 7d), sum(m, 7d), min(m, 30d), max(m, 30d), z(m, 30d) (today's value as a z-score against the window), pct_change(m, 7d, 28d), clamp(x, lo, hi), scale(x, lo, hi) (maps to 0–100), and other custom metrics by name. m is a metric id from get_metric_series. Use 'hrv' (not hrv_sdnn/hrv_rmssd) so the metric works on any phone. Example readiness: scale(0.5*z(hrv, 30d) - 0.3*z(resting_heart_rate, 30d) + 0.2*z(sleep_hours, 14d), -2, 2). The user approves new metrics on the phone.",
    inputSchema: {
      name: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "snake_case, 2–40 chars").describe("Identifier, e.g. readiness."),
      title: z.string().min(1).max(40).describe("Display name on the card, e.g. 'Readiness'."),
      expression: z.string().min(1).max(500),
      unit: z.string().max(16).optional(),
      description: z.string().min(1).max(300).describe("One or two sentences the user will read: what it measures and how to read it."),
      higher_is_better: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Create a custom metric" },
  },
  {
    name: "list_custom_metrics",
    title: "List custom metrics",
    description: "The user's custom metrics with their formulas and latest values.",
    inputSchema: {},
    annotations: { ...READ, title: "List custom metrics" },
  },
  {
    name: "compute_custom_metric",
    title: "Compute a custom metric",
    description: "Daily values of a custom metric over a date range, computed on the phone.",
    inputSchema: { name: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), ...range },
    annotations: { ...READ, title: "Compute a custom metric" },
    maxDays: 400,
  },
  {
    name: "delete_custom_metric",
    title: "Delete a custom metric",
    description: "Remove a custom metric (asks the user to confirm on the phone).",
    inputSchema: { name: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: "Delete a custom metric" },
  },
  {
    name: "relay_status",
    title: "Relay status",
    description:
      "Whether the user's phone can answer right now: 'live' (app open), 'notify' (requests arrive as notifications to approve) or 'offline'. Call it when a request failed or before a long analysis.",
    inputSchema: {},
    annotations: { ...READ, title: "Relay status" },
    serverSide: true,
  },
  {
    name: "get_pending_result",
    title: "Get a pending answer",
    description:
      "Fetch the answer to an earlier request that was waiting for the user's approval on their phone. Waits up to about 25 seconds. Answers are kept in memory for 10 minutes, then dropped.",
    inputSchema: { request_id: z.string().regex(/^r_[A-Za-z0-9_-]{4,20}$/) },
    annotations: { ...READ, title: "Get a pending answer" },
    serverSide: true,
  },
];

// ── human-readable request summaries (push notifications, ledger) ──────────
const pretty = (m: string) => m.replace(/_/g, " ").replace(/\bhrv( sdnn| rmssd)?\b/, "HRV").replace(/^\w/, (c) => c.toUpperCase());

function span(args: Record<string, unknown>): string {
  const s = args.start as string | undefined;
  const e = args.end as string | undefined;
  if (!s && !e) return "last 7 days";
  if (s && e) return `${s} → ${e}`;
  return s ? `from ${s}` : `until ${e}`;
}

export function describeRequest(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "health_overview":
      return `Daily overview · ${(args.date as string) ?? "today"}`;
    case "get_metric_series":
      return `${pretty(String(args.metric))} · ${args.granularity ?? "day"} · ${span(args)}`;
    case "list_workouts":
      return `Workouts${args.activity_type ? ` (${args.activity_type})` : ""} · ${span(args)}`;
    case "get_workout":
      return "One workout · details";
    case "get_sleep":
      return `Sleep · ${span(args)}`;
    case "list_available_metrics":
      return "Which metrics are available";
    case "define_metric":
      return `New metric “${args.title ?? args.name}”`;
    case "list_custom_metrics":
      return "Custom metrics";
    case "compute_custom_metric":
      return `${pretty(String(args.name))} · ${span(args)}`;
    case "delete_custom_metric":
      return `Delete metric “${args.name}”`;
    default:
      return tool;
  }
}

/** Server-side guard so a single call can't ask the phone for years of raw samples. */
export function checkRange(def: ToolDef, args: Record<string, unknown>): string | undefined {
  // same defaults as the phone: end = today, start = end - 6 days
  const e = (args.end as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const s = (args.start as string | undefined) ?? new Date(Date.parse(e) - 6 * 86_400_000).toISOString().slice(0, 10);
  {
    const days = (Date.parse(e) - Date.parse(s)) / 86_400_000;
    if (Number.isNaN(days)) return "Invalid date.";
    if (days < 0) return "start must not be after end.";
    if (def.maxDays && days > def.maxDays) return `Range too long (max ${def.maxDays} days for ${def.name}).`;
    if (def.name === "get_metric_series") {
      if (args.granularity === "raw" && days > 3) return "Raw samples are limited to 3 days — use granularity 'day' or 'hour'.";
      if (args.granularity === "hour" && days > 14) return "Hourly data is limited to 14 days — use granularity 'day'.";
    }
  }
  return undefined;
}
