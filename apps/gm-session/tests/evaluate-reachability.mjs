/**
 * Node self-check for evaluateNamedFunction ancestor reachability + arithmetic detail.
 * Run: node apps/gm-session/tests/evaluate-reachability.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(__dirname, "..", "sheet-runtime.js");
const code = readFileSync(runtimePath, "utf8");
const sandbox = { console, Math, Number, String, Object, Array, Set, Map, Error };
sandbox.globalThis = sandbox;
sandbox.window = undefined;
vm.runInNewContext(code, sandbox);
const { evaluateNamedFunction } = sandbox.SheetRuntime;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Repro graph: entry→roll→+←STR, +→send_to_chat */
function attackGraph(includeArithmetic) {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "attack" },
      { id: "r", kind: "roll", sides: 20 },
      { id: "str", kind: "field", field: "STR", role: "source" },
      { id: "add", kind: "op", op: "+" },
      {
        id: "chat",
        kind: "send_to_chat",
        label: "Attack",
        include_arithmetic: includeArithmetic,
      },
    ],
    edges: [
      { id: "e1", from: "e", to: "r", toPort: 0 },
      { id: "e2", from: "r", to: "add", toPort: 0 },
      { id: "e3", from: "str", to: "add", toPort: 1 },
      { id: "e4", from: "add", to: "chat", toPort: 0 },
    ],
  };
}

// Deterministic d20 = 15 → Math.random in [14/20, 15/20)
const origRandom = Math.random;
Math.random = () => 0.74; // floor(0.74*20)+1 = 15

const beforeWouldBeBroken = (() => {
  // Document expected failure mode of pre-0.6.6: STR not evaluated → value === roll
  // We cannot run old code; assert fix instead.
  return null;
})();

const res = evaluateNamedFunction(attackGraph(false), "attack", { STR: 10 });
assert(res.ok, `eval failed: ${res.error}`);
assert(res.values.str === 10, `STR field should evaluate to 10, got ${res.values.str}`);
assert(res.values.r === 15, `roll should be 15, got ${res.values.r}`);
assert(res.values.add === 25, `+ should be 25 (15+10), got ${res.values.add}`);
assert(res.messages.length === 1, "expected one chat message");
assert(res.messages[0].value === 25, `chat value should be 25, got ${res.messages[0].value}`);
assert(
  res.messages[0].value !== res.values.r,
  "chat value must not equal bare roll when STR feeds +"
);

const resArith = evaluateNamedFunction(attackGraph(true), "attack", { STR: 10 });
assert(resArith.ok, `arith eval failed: ${resArith.error}`);
assert(resArith.messages[0].value === 25, "arith chat value 25");
const detail = resArith.messages[0].detail || "";
assert(
  detail.includes("15 (d20)") && detail.includes("10 (STR)") && detail.includes("= 25"),
  `expected arithmetic detail like '15 (d20) + 10 (STR) = 25', got: ${detail}`
);
assert(detail === "15 (d20) + 10 (STR) = 25", `exact detail mismatch: ${detail}`);

const quiet = evaluateNamedFunction(attackGraph(false), "attack", { STR: 10 });
assert(!quiet.messages[0].detail || !String(quiet.messages[0].detail).includes("="),
  "include_arithmetic false should not put equation in detail");

Math.random = origRandom;
console.log("OK evaluate-reachability: STR ancestor + arithmetic detail");
console.log("  before(bug): chat value === roll (STR skipped)");
console.log("  after: chat value === 25 (15+10); detail '15 (d20) + 10 (STR) = 25'");
