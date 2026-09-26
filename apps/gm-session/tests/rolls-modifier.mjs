// 0.7.2: constant modifier on Rolls & Chat dice (shared component used by GM + player).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const RC = require("../rolls-chat.js");

let n = 0;
const ok = (msg) => { n++; console.log("ok -", msg); };

assert.deepEqual(RC.rollBody("1d20", 14, 3), { kind: "roll", label: "1d20 + 3", result: 17, detail: "14 + 3 = 17" });
ok("1d20 + 3 → 17 with detail 14 + 3 = 17");
assert.deepEqual(RC.rollBody("1d20", 14, 0), { kind: "roll", label: "1d20", result: 14, detail: "" });
ok("no modifier → plain roll, no detail");
assert.deepEqual(RC.rollBody("1d6", 2, -5), { kind: "roll", label: "1d6 − 5", result: -3, detail: "2 − 5 = -3" });
ok("negative modifier subtracts (result may go below zero)");
assert.equal(RC.rollBody("Bell μ=10 σ=3", 11, 2).label, "Bell μ=10 σ=3 + 2");
ok("bell sample carries the modifier in the label");
for (const [inp, want] of [["3", 3], ["-4", -4], ["", 0], ["abc", 0], ["2.9", 2], ["-2.9", -2], ["1e9", 1e6], [null, 0], [" 7 ", 7]]) {
  assert.equal(RC.parseMod(inp), want, `parseMod(${JSON.stringify(inp)})`);
}
ok("modifier parsing: integers, blanks/invalid → 0, truncation, clamp ±1e6");
const seq = [0.999999, 0];
for (let i = 0; i < 200; i++) {
  const r = RC.rollUniformInt(20);
  assert.ok(r >= 1 && r <= 20 && Number.isInteger(r));
}
assert.equal(RC.rollUniformInt(20, () => seq[0]), 20);
assert.equal(RC.rollUniformInt(20, () => seq[1]), 1);
ok("uniform die stays in 1..N");
const body = RC.rollBody("1d20", RC.rollUniformInt(20), RC.parseMod("3"));
assert.equal(body.result, Number(body.detail.split(" = ")[1]));
ok("result equals base + modifier");
console.log(`rolls-modifier: ${n} checks passed`);
