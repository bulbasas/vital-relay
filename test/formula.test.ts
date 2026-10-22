import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, inputs, parse, FormulaError } from "../src/formula.ts";

const series = (data: Record<string, number[]>) => (m: string, d: number) => data[m]?.[d];

test("parses and evaluates arithmetic with precedence", () => {
  assert.equal(evaluate(parse("1 + 2 * 3 - -4 / 2"), () => undefined), 9);
});

test("bare metric means today's value; avg uses a window", () => {
  const v = series({ steps: [10000, 8000, 6000] });
  assert.equal(evaluate(parse("steps / 1000"), v), 10);
  assert.equal(evaluate(parse("avg(steps, 3d)"), v), 8000);
});

test("z-score excludes the day itself from the baseline", () => {
  const v = series({ hrv_sdnn: [70, 50, 50, 50, 60, 40] });
  const z = evaluate(parse("z(hrv_sdnn, 5d)"), v)!;
  assert.ok(Math.abs(z - 20 / Math.sqrt(40)) < 1e-9);
});

test("scale maps to 0-100 and clamps", () => {
  assert.equal(evaluate(parse("scale(5, 0, 10)"), () => undefined), 50);
  assert.equal(evaluate(parse("scale(50, 0, 10)"), () => undefined), 100);
});

test("readiness example from the tool description parses", () => {
  const n = parse("scale(0.5*z(hrv_sdnn, 30d) - 0.3*z(resting_heart_rate, 30d) + 0.2*z(sleep_hours, 14d), -2, 2)");
  assert.deepEqual([...inputs(n)].sort(), ["hrv_sdnn", "resting_heart_rate", "sleep_hours"]);
});

test("missing data yields undefined, division by zero too", () => {
  assert.equal(evaluate(parse("avg(steps, 7d)"), () => undefined), undefined);
  assert.equal(evaluate(parse("1 / 0"), () => undefined), undefined);
});

test("rejects code-like input and unknown names", () => {
  for (const bad of ["fetch(1)", "steps; 1", "avg(steps)", "avg(steps, 999d)", "7d", "foo", "a.b", "steps ** 2"]) {
    assert.throws(() => parse(bad), FormulaError, bad);
  }
});

test("custom metric names are allowed when known or when validating syntax only", () => {
  assert.throws(() => parse("readiness * 2"), FormulaError);
  assert.doesNotThrow(() => parse("readiness * 2", ["readiness"]));
  assert.doesNotThrow(() => parse("readiness * 2", "any"));
});
