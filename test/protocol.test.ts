import { test } from "node:test";
import assert from "node:assert/strict";
import { depthWithin, isPhoneAnswer } from "../src/protocol.ts";
import { checkRange, TOOLS } from "../src/tools.ts";

const nest = (n: number) => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

test("depthWithin is iterative and survives hostile nesting", () => {
  assert.equal(depthWithin(nest(10), 32), true);
  assert.equal(depthWithin(nest(100_000), 32), false); // would blow the stack if recursive
});

test("answers must be text-only, bounded and shallow", () => {
  const ok = { type: "response", id: "r_x", ok: true, result: { content: [{ type: "text", text: "{}" }] } };
  assert.equal(isPhoneAnswer(ok), true);
  assert.equal(isPhoneAnswer({ ...ok, result: { content: [{ type: "image", data: "x" }] } }), false);
  assert.equal(isPhoneAnswer({ ...ok, result: { content: [], structuredContent: nest(5000) } }), false);
  assert.equal(isPhoneAnswer({ ...ok, x: nest(5000) }), true); // unknown keys are ignored, never stringified
  assert.equal(isPhoneAnswer({ type: "response", id: "r_x", ok: false, error: { code: "DENIED" } }), false);
});

test("range guard applies when start or end is missing", () => {
  const series = TOOLS.find((t) => t.name === "get_metric_series")!;
  assert.match(checkRange(series, { granularity: "raw", start: "1900-01-01" }) ?? "", /Range too long|Raw samples/);
  assert.equal(checkRange(series, { granularity: "day" }), undefined);
});
