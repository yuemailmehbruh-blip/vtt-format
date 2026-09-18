/**
 * [x] parameterized template functions.
 * Run: node apps/gm-session/tests/evaluate-templates.mjs
 */
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

/** Template: f_[x] → field [x]_PROF */
function templateGraph() {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "f_[x]" },
      { id: "prof", kind: "field", field: "[x]_PROF", role: "source" },
      { id: "out", kind: "field", field: "result", role: "output" },
      {
        id: "chat",
        kind: "send_to_chat",
        label: "check_[x]",
        include_arithmetic: false,
      },
    ],
    edges: [
      { id: "e1", from: "e", to: "prof", toPort: 0 },
      { id: "e2", from: "prof", to: "out", toPort: 0 },
      { id: "e3", from: "out", to: "chat", toPort: 0 },
    ],
  };
}

/** Non-template concrete entry still works */
function concreteGraph() {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "attack" },
      { id: "c", kind: "const", value: 7 },
      { id: "chat", kind: "send_to_chat", label: "Attack" },
    ],
    edges: [
      { id: "e1", from: "e", to: "c", toPort: 0 },
      { id: "e2", from: "c", to: "chat", toPort: 0 },
    ],
  };
}

/** Active arithmetic still OK with templates */
function arithTemplateGraph() {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "roll_[x]" },
      { id: "r", kind: "roll", sides: 20 },
      { id: "mod", kind: "field", field: "[x]_mod", role: "source" },
      { id: "add", kind: "op", op: "+" },
      {
        id: "chat",
        kind: "send_to_chat",
        label: "Roll [x]",
        include_arithmetic: true,
      },
    ],
    edges: [
      { id: "e1", from: "e", to: "r", toPort: 0 },
      { id: "e2", from: "r", to: "add", toPort: 0 },
      { id: "e3", from: "mod", to: "add", toPort: 1 },
      { id: "e4", from: "add", to: "chat", toPort: 0 },
    ],
  };
}

const g = templateGraph();
const storedBefore = JSON.stringify(g);

const resPlain = evaluateNamedFunction(g, "f_ATK", { ATK_PROF: 42 });
assert(resPlain.ok, `f_ATK failed: ${resPlain.error}`);
assert(resPlain.values.prof === 42, `expected ATK_PROF=42, got ${resPlain.values.prof}`);
assert(resPlain.writes.result === 42, `write result 42, got ${resPlain.writes.result}`);
assert(resPlain.messages[0].text === "check_ATK", `label sub: ${resPlain.messages[0].text}`);

const resBracket = evaluateNamedFunction(g, "f_[ATK]", { ATK_PROF: 99 });
assert(resBracket.ok, `f_[ATK] failed: ${resBracket.error}`);
assert(resBracket.values.prof === 99, `bracket ATK_PROF=99, got ${resBracket.values.prof}`);
assert(resBracket.messages[0].text === "check_ATK", "bracket label becomes check_ATK");

assert(JSON.stringify(g) === storedBefore, "stored graph must not be mutated");

const miss = evaluateNamedFunction(g, "f_", { ATK_PROF: 1 });
assert(!miss.ok, "empty/missing ID should fail");
assert(/No entry|Ambiguous|needs an ID/i.test(miss.error || ""), `unexpected: ${miss.error}`);

const miss2 = evaluateNamedFunction(g, "f_[x]", {});
assert(!miss2.ok, "exact template name should fail clearly");
assert(/Template|needs an ID/i.test(miss2.error || ""), `template exact: ${miss2.error}`);

const conc = evaluateNamedFunction(concreteGraph(), "attack", {});
assert(conc.ok, `concrete failed: ${conc.error}`);
assert(conc.messages[0].value === 7, "concrete const still works");

const origRandom = Math.random;
Math.random = () => 0.74; // d20 → 15
const ar = evaluateNamedFunction(arithTemplateGraph(), "roll_STR", { STR_mod: 10 });
assert(ar.ok, `arith template failed: ${ar.error}`);
assert(ar.messages[0].value === 25, `15+10=25, got ${ar.messages[0].value}`);
const detail = ar.messages[0].detail || "";
assert(
  detail.includes("15 (d20)") && detail.includes("10 (STR_mod)") && detail.includes("= 25"),
  `arith detail: ${detail}`
);
Math.random = origRandom;

// Longest template wins
const multi = {
  nodes: [
    { id: "e1", kind: "entry", name: "check_[x]" },
    { id: "e2", kind: "entry", name: "check_skill_[x]" },
    { id: "c1", kind: "const", value: 1 },
    { id: "c2", kind: "const", value: 2 },
    { id: "ch1", kind: "send_to_chat", label: "short" },
    { id: "ch2", kind: "send_to_chat", label: "long" },
  ],
  edges: [
    { id: "a", from: "e1", to: "c1", toPort: 0 },
    { id: "b", from: "c1", to: "ch1", toPort: 0 },
    { id: "c", from: "e2", to: "c2", toPort: 0 },
    { id: "d", from: "c2", to: "ch2", toPort: 0 },
  ],
};
const long = evaluateNamedFunction(multi, "check_skill_ATK", {});
assert(long.ok, `longest failed: ${long.error}`);
assert(long.messages[0].text === "long", `expected long template, got ${long.messages[0].text}`);
assert(long.messages[0].value === 2, "longest template const 2");

console.log("evaluate-templates: ok");
