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

// --- Active arithmetic path: if unwraps to taken branch only ---
/** d20 + if(atk_prof, PROF+STR_mod, STR_mod) → chat */
function attackWithIfProf(includeArithmetic) {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "attack" },
      { id: "r", kind: "roll", sides: 20 },
      { id: "prof", kind: "field", field: "atk_prof", role: "source" },
      { id: "pb", kind: "field", field: "PROF", role: "source" },
      { id: "smod", kind: "field", field: "STR_mod", role: "source" },
      { id: "thenAdd", kind: "op", op: "+" },
      { id: "iff", kind: "op", op: "if" },
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
      { id: "e2", from: "pb", to: "thenAdd", toPort: 0 },
      { id: "e3", from: "smod", to: "thenAdd", toPort: 1 },
      { id: "e4", from: "prof", to: "iff", toPort: 0 },
      { id: "e5", from: "thenAdd", to: "iff", toPort: 1 },
      { id: "e6", from: "smod", to: "iff", toPort: 2 },
      { id: "e7", from: "r", to: "add", toPort: 0 },
      { id: "e8", from: "iff", to: "add", toPort: 1 },
      { id: "e9", from: "add", to: "chat", toPort: 0 },
    ],
  };
}

const envOn = { atk_prof: 1, PROF: 5, STR_mod: 2 };
const resIfOn = evaluateNamedFunction(attackWithIfProf(true), "attack", envOn);
assert(resIfOn.ok, `if-on eval failed: ${resIfOn.error}`);
assert(resIfOn.messages[0].value === 22, `if-on chat value 22, got ${resIfOn.messages[0].value}`);
const dOn = resIfOn.messages[0].detail || "";
assert(
  dOn === "15 (d20) + 5 (PROF) + 2 (STR_mod) = 22",
  `if-on active path detail expected, got: ${dOn}`
);
assert(!dOn.includes("if(") && !dOn.includes("atk_prof"), "if-on must omit if/cond");

const envOff = { atk_prof: 0, PROF: 5, STR_mod: 2 };
const resIfOff = evaluateNamedFunction(attackWithIfProf(true), "attack", envOff);
assert(resIfOff.ok, `if-off eval failed: ${resIfOff.error}`);
assert(resIfOff.messages[0].value === 17, `if-off chat value 17, got ${resIfOff.messages[0].value}`);
const dOff = resIfOff.messages[0].detail || "";
assert(
  dOff === "15 (d20) + 2 (STR_mod) = 17",
  `if-off active path detail expected, got: ${dOff}`
);
assert(!dOff.includes("PROF") && !dOff.includes("if("), "if-off must omit untaken PROF branch and if");

Math.random = origRandom;
console.log("OK evaluate-reachability: STR ancestor + arithmetic detail");
console.log("  before(bug): chat value === roll (STR skipped)");
console.log("  after: chat value === 25 (15+10); detail '15 (d20) + 10 (STR) = 25'");
console.log("  if active path: on → '15 (d20) + 5 (PROF) + 2 (STR_mod) = 22'; off → omit PROF/if");
