// Pulse Lab formula language — declarative configuration, not code.
// Reference implementation: the relay validates with it, the simulator evaluates with it,
// and ios-app/…/Lab/Formula.swift is a line-by-line port. Keep them identical.
//
//   expr    := term (("+" | "-") term)*
//   term    := unary (("*" | "/") unary)*
//   unary   := "-" unary | primary
//   primary := number | ident "(" args ")" | ident | "(" expr ")"
//   arg     := expr | window            window := digits "d"   (1d … 365d)
//
// A bare identifier is today's value of a metric (or of another custom metric).
import { METRICS } from "./tools.ts";

export type Node =
  | { k: "num"; v: number }
  | { k: "ref"; name: string }
  | { k: "win"; days: number }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

/** fn → argument kinds: m = metric id, w = window, x = expression */
export const FUNCTIONS: Record<string, string[]> = {
  today: ["m"],
  last: ["m"],
  avg: ["m", "w"],
  sum: ["m", "w"],
  min: ["m", "w"],
  max: ["m", "w"],
  z: ["m", "w"],
  pct_change: ["m", "w", "w"],
  clamp: ["x", "x", "x"],
  scale: ["x", "x", "x"],
  abs: ["x"],
  round: ["x"],
};

const MAX_NODES = 200;
const MAX_WINDOW = 365;

type Tok = { t: "num" | "id" | "win" | "op"; v: string; at: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(\d+)d\b/))) { out.push({ t: "win", v: m[1], at: i }); i += m[0].length; continue; }
    if ((m = rest.match(/^\d+(\.\d+)?|^\.\d+/))) { out.push({ t: "num", v: m[0], at: i }); i += m[0].length; continue; }
    if ((m = rest.match(/^[a-z][a-z0-9_]*/))) { out.push({ t: "id", v: m[0], at: i }); i += m[0].length; continue; }
    if ("+-*/(),".includes(c)) { out.push({ t: "op", v: c, at: i }); i++; continue; }
    throw new FormulaError(`Unexpected character '${c}' at ${i}`);
  }
  return out;
}

export class FormulaError extends Error {}

/** customNames: the user's custom metric names, or "any" when unknown (the relay validates syntax only). */
export function parse(src: string, customNames: string[] | "any" = []): Node {
  if (src.length > 500) throw new FormulaError("Formula too long (max 500 characters).");
  const toks = lex(src);
  let p = 0;
  let nodes = 0;
  const count = <T extends Node>(n: T): T => {
    if (++nodes > MAX_NODES) throw new FormulaError("Formula too complex.");
    return n;
  };
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && t.v !== v)) throw new FormulaError(`Expected '${v ?? "value"}' ${t ? `at ${t.at}` : "at end"}`);
    p++;
    return t;
  };
  const isMetric = (name: string) => name in METRICS || customNames === "any" || customNames.includes(name);

  function expr(): Node {
    let a = term();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = eat().v as "+" | "-";
      a = count({ k: "bin", op, a, b: term() });
    }
    return a;
  }
  function term(): Node {
    let a = unary();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = eat().v as "*" | "/";
      a = count({ k: "bin", op, a, b: unary() });
    }
    return a;
  }
  function unary(): Node {
    if (peek()?.t === "op" && peek().v === "-") { eat(); return count({ k: "neg", a: unary() }); }
    return primary();
  }
  function primary(): Node {
    const t = peek();
    if (!t) throw new FormulaError("Unexpected end of formula.");
    if (t.t === "num") { eat(); return count({ k: "num", v: Number(t.v) }); }
    if (t.t === "op" && t.v === "(") { eat("("); const e = expr(); eat(")"); return e; }
    if (t.t === "win") throw new FormulaError(`A window like ${t.v}d is only allowed as a function argument.`);
    if (t.t === "id") {
      eat();
      if (peek()?.v === "(") {
        const sig = FUNCTIONS[t.v];
        if (!sig) throw new FormulaError(`Unknown function '${t.v}'. Allowed: ${Object.keys(FUNCTIONS).join(", ")}.`);
        eat("(");
        const args: Node[] = [];
        for (let i = 0; i < sig.length; i++) {
          if (i > 0) eat(",");
          const kind = sig[i];
          const a = peek();
          if (kind === "w") {
            if (a?.t !== "win") throw new FormulaError(`${t.v}(): argument ${i + 1} must be a window like 7d.`);
            eat();
            const days = Number(a.v);
            if (days < 1 || days > MAX_WINDOW) throw new FormulaError(`Window must be 1d–${MAX_WINDOW}d.`);
            args.push(count({ k: "win", days }));
          } else if (kind === "m") {
            if (a?.t !== "id" || !isMetric(a.v)) throw new FormulaError(`${t.v}(): argument ${i + 1} must be a metric id (e.g. hrv).`);
            eat();
            args.push(count({ k: "ref", name: a.v }));
          } else args.push(expr());
        }
        eat(")");
        return count({ k: "call", fn: t.v, args });
      }
      if (!isMetric(t.v)) throw new FormulaError(`Unknown metric '${t.v}'.`);
      return count({ k: "ref", name: t.v });
    }
    throw new FormulaError(`Unexpected '${t.v}' at ${t.at}.`);
  }

  const tree = expr();
  if (p < toks.length) throw new FormulaError(`Unexpected '${toks[p].v}' at ${toks[p].at}.`);
  return tree;
}

/** Metric ids a formula reads (for permission checks and the ledger). */
export function inputs(n: Node, acc = new Set<string>()): Set<string> {
  if (n.k === "ref") acc.add(n.name);
  else if (n.k === "neg") inputs(n.a, acc);
  else if (n.k === "bin") { inputs(n.a, acc); inputs(n.b, acc); }
  else if (n.k === "call") n.args.forEach((a) => inputs(a, acc));
  return acc;
}

/** Daily values provider: value(metric, dayOffset) where 0 = the day being computed, 1 = the day before … */
export type Series = (metric: string, dayOffset: number) => number | undefined;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function evaluate(n: Node, value: Series): number | undefined {
  const window = (m: string, days: number, from = 0) => {
    const xs: number[] = [];
    for (let d = from; d < from + days; d++) {
      const v = value(m, d);
      if (v !== undefined && Number.isFinite(v)) xs.push(v);
    }
    return xs;
  };
  const ev = (x: Node): number | undefined => {
    switch (x.k) {
      case "num": return x.v;
      case "win": return x.days;
      case "ref": return value(x.name, 0);
      case "neg": { const a = ev(x.a); return a === undefined ? undefined : -a; }
      case "bin": {
        const a = ev(x.a), b = ev(x.b);
        if (a === undefined || b === undefined) return undefined;
        if (x.op === "+") return a + b;
        if (x.op === "-") return a - b;
        if (x.op === "*") return a * b;
        return b === 0 ? undefined : a / b;
      }
      case "call": {
        const [p, q, r] = x.args;
        const m = p.k === "ref" ? p.name : "";
        const days = q?.k === "win" ? q.days : 0;
        switch (x.fn) {
          case "today": return value(m, 0);
          case "last": { for (let d = 0; d < 30; d++) { const v = value(m, d); if (v !== undefined) return v; } return undefined; }
          case "avg": { const xs = window(m, days); return xs.length ? mean(xs) : undefined; }
          case "sum": { const xs = window(m, days); return xs.length ? xs.reduce((s, v) => s + v, 0) : undefined; }
          case "min": { const xs = window(m, days); return xs.length ? Math.min(...xs) : undefined; }
          case "max": { const xs = window(m, days); return xs.length ? Math.max(...xs) : undefined; }
          case "z": {
            const t = value(m, 0);
            const xs = window(m, days, 1); // baseline excludes the day itself
            if (t === undefined || xs.length < 3) return undefined;
            const mu = mean(xs);
            const sd = Math.sqrt(mean(xs.map((v) => (v - mu) ** 2)));
            return sd === 0 ? 0 : (t - mu) / sd;
          }
          case "pct_change": {
            const a = window(m, days), b = window(m, r?.k === "win" ? r.days : 0);
            if (!a.length || !b.length) return undefined;
            const mb = mean(b);
            return mb === 0 ? undefined : ((mean(a) - mb) / mb) * 100;
          }
          case "clamp": { const v = ev(p), lo = ev(q), hi = ev(r); return v === undefined || lo === undefined || hi === undefined ? undefined : Math.min(hi, Math.max(lo, v)); }
          case "scale": {
            const v = ev(p), lo = ev(q), hi = ev(r);
            if (v === undefined || lo === undefined || hi === undefined || hi === lo) return undefined;
            return ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
          }
          case "abs": { const v = ev(p); return v === undefined ? undefined : Math.abs(v); }
          case "round": { const v = ev(p); return v === undefined ? undefined : Math.round(v); }
        }
        return undefined;
      }
    }
  };
  return ev(n);
}
