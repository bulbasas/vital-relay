// Runs the shared formula vectors in contracts/ — the iOS and Android ports run the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, inputs, parse, FormulaError } from "../src/formula.ts";

type Series = Record<string, (number | null)[]>;
const c = JSON.parse(readFileSync(new URL("../contracts/formula-cases.json", import.meta.url), "utf8")) as {
  evaluate: { expr: string; series?: Series; expect: number | null }[];
  inputs: { expr: string; inputs: string[] }[];
  reject: string[];
  custom: { expr: string; customNames: string[] | "any"; valid: boolean }[];
};

test("contract: evaluate", () => {
  for (const k of c.evaluate) {
    const s = k.series ?? {};
    const got = evaluate(parse(k.expr), (m, d) => s[m]?.[d] ?? undefined);
    if (k.expect === null) assert.equal(got, undefined, k.expr);
    else assert.ok(got !== undefined && Math.abs(got - k.expect) < 1e-9, `${k.expr} → ${got}, want ${k.expect}`);
  }
});

test("contract: inputs", () => {
  for (const k of c.inputs) assert.deepEqual([...inputs(parse(k.expr))].sort(), [...k.inputs].sort(), k.expr);
});

test("contract: reject", () => {
  for (const e of c.reject) assert.throws(() => parse(e), FormulaError, e);
});

test("contract: custom metric names", () => {
  for (const k of c.custom) assert.doesNotThrow(() => parse(k.expr, k.customNames), k.expr);
});
