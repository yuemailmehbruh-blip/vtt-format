/**
 * Round op (0.6.17): mode up (ceil) / down (floor) / nearest (floor(x + 0.5)).
 * Covers named-function eval, closed formulas, compile, [x] formula macros,
 * live widget resolve, chat arithmetic text, and legacy/no-mode sheets.
 * Run: node apps/gm-session/tests/round-op.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, "..", "sheet-runtime.js"), "utf8");
const sandbox = { console, Math, Number, String, Object, Array, Set, Map, Error, JSON };
sandbox.globalThis = sandbox;
sandbox.window = undefined;
vm.runInNewContext(code, sandbox);
const RT = sandbox.SheetRuntime;
const {
  evaluateNamedFunction,
  evalClosedFormula,
  arityOf,
  compileGraph,
  expandFormulaMacrosForId,
  resolveWidgetValue,
} = RT;

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) throw new Error(msg);
}
// Object.is so -0 vs 0 does not matter for the comparisons we care about
const eq = (a, b) => a === b || (a === 0 && b === 0);

assert(arityOf({ kind: "op", op: "round" }) === 1, "round arity 1");

/** entry → field X → round(mode) → output OUT + chat */
function roundGraph(mode) {
  const rn = { id: "r", kind: "op", op: "round", x: 0, y: 0 };
  if (mode !== undefined) rn.mode = mode;
  return {
    nodes: [
      { id: "entry", kind: "entry", name: "rnd", x: 0, y: 0 },
      { id: "src", kind: "field", field: "X", role: "source", x: 0, y: 0 },
      rn,
      { id: "out", kind: "field", field: "OUT", role: "output", x: 0, y: 0 },
      { id: "chat", kind: "send_to_chat", label: "R", include_arithmetic: true, x: 0, y: 0 },
    ],
    edges: [
      { id: "e0", from: "entry", to: "src", toPort: 0 },
      { id: "e1", from: "src", to: "r", toPort: 0 },
      { id: "e2", from: "r", to: "out", toPort: 0 },
      { id: "e3", from: "r", to: "chat", toPort: 0 },
    ],
  };
}

const cases = {
  up: [
    [2.1, 3], [2.5, 3], [2.9, 3], [2, 2], [0, 0],
    [-2.1, -2], [-2.5, -2], [-2.9, -2], [-2, -2], [0.5, 1], [-0.5, 0],
  ],
  down: [
    [2.1, 2], [2.5, 2], [2.9, 2], [2, 2], [0, 0],
    [-2.1, -3], [-2.5, -3], [-2.9, -3], [-2, -2], [0.5, 0], [-0.5, -1],
  ],
  nearest: [
    [2.1, 2], [2.4, 2], [2.5, 3], [2.6, 3], [3.5, 4], [2, 2], [0, 0],
    [-2.1, -2], [-2.4, -2], [-2.5, -2], [-2.6, -3], [-3.5, -3], [-2, -2],
    [0.5, 1], [-0.5, 0], [1.5, 2], [-1.5, -1],
  ],
};
const fnName = { up: "ceil", down: "floor", nearest: "round" };

for (const [mode, list] of Object.entries(cases)) {
  const g = roundGraph(mode);
  const compiled = compileGraph(g, ["X", "OUT"]);
  assert(!compiled.error, `compile ${mode}: ${compiled.error}`);
  assert(compiled.formulas.OUT === `${fnName[mode]}(X)`, `formula ${mode}: ${compiled.formulas.OUT}`);
  for (const [x, want] of list) {
    const r = evaluateNamedFunction(g, "rnd", { X: x });
    assert(r.ok, `eval ${mode}(${x}): ${r.error}`);
    assert(eq(r.writes.OUT, want), `${mode}(${x}) → ${r.writes.OUT}, want ${want}`);
    // Compiled closed formula must agree with graph evaluation
    const f = evalClosedFormula(compiled.formulas.OUT, { X: x });
    assert(eq(f, want), `formula ${mode}(${x}) → ${f}, want ${want}`);
    assert(eq(RT.applyRound(mode, x), want), `applyRound ${mode}(${x})`);
  }
}

// Closed formula language directly
assert(evalClosedFormula("round(2.5)", {}) === 3, "round(2.5)=3");
assert(evalClosedFormula("round(-2.5)", {}) === -2, "round(-2.5)=-2");
assert(evalClosedFormula("ceil(-2.5)", {}) === -2, "ceil(-2.5)=-2");
assert(evalClosedFormula("floor(-2.5)", {}) === -3, "floor(-2.5)=-3");
assert(evalClosedFormula("round(X / 2) + 1", { X: 5 }) === 4, "round in expr");

// Chat arithmetic text
{
  const up = evaluateNamedFunction(roundGraph("up"), "rnd", { X: 2.2 });
  assert(up.messages[0].detail === "round↑(2.2 (X)) = 3", `chat up: ${up.messages[0].detail}`);
  const dn = evaluateNamedFunction(roundGraph("down"), "rnd", { X: 2.7 });
  assert(dn.messages[0].detail === "round↓(2.7 (X)) = 2", `chat down: ${dn.messages[0].detail}`);
  const nr = evaluateNamedFunction(roundGraph("nearest"), "rnd", { X: -2.5 });
  assert(nr.messages[0].detail === "round(-2.5 (X)) = -2", `chat nearest: ${nr.messages[0].detail}`);
}

// Legacy / missing mode → nearest; bogus mode → nearest
{
  const r = evaluateNamedFunction(roundGraph(undefined), "rnd", { X: 2.5 });
  assert(r.ok && r.writes.OUT === 3, "no mode defaults nearest");
  const c = compileGraph(roundGraph(undefined), ["X", "OUT"]);
  assert(c.formulas.OUT === "round(X)", "no mode compiles round()");
  const b = evaluateNamedFunction(roundGraph("sideways"), "rnd", { X: 2.4 });
  assert(b.ok && b.writes.OUT === 2, "invalid mode → nearest");
}

// Round feeding a downstream op: round↓(X / 2) * 10 → OUT
{
  const g = {
    nodes: [
      { id: "entry", kind: "entry", name: "chain", x: 0, y: 0 },
      { id: "src", kind: "field", field: "X", role: "source", x: 0, y: 0 },
      { id: "c2", kind: "const", value: 2, x: 0, y: 0 },
      { id: "div", kind: "op", op: "/", x: 0, y: 0 },
      { id: "r", kind: "op", op: "round", mode: "up", x: 0, y: 0 },
      { id: "c10", kind: "const", value: 10, x: 0, y: 0 },
      { id: "mul", kind: "op", op: "*", x: 0, y: 0 },
      { id: "out", kind: "field", field: "OUT", role: "output", x: 0, y: 0 },
      { id: "chat", kind: "send_to_chat", label: "", include_arithmetic: true, x: 0, y: 0 },
    ],
    edges: [
      { id: "e0", from: "entry", to: "src", toPort: 0 },
      { id: "e1", from: "src", to: "div", toPort: 0 },
      { id: "e2", from: "c2", to: "div", toPort: 1 },
      { id: "e3", from: "div", to: "r", toPort: 0 },
      { id: "e4", from: "r", to: "mul", toPort: 0 },
      { id: "e5", from: "c10", to: "mul", toPort: 1 },
      { id: "e6", from: "mul", to: "out", toPort: 0 },
      { id: "e7", from: "mul", to: "chat", toPort: 0 },
    ],
  };
  const r = evaluateNamedFunction(g, "chain", { X: 5 });
  assert(r.ok && r.writes.OUT === 30, `ceil(5/2)*10 = 30, got ${r.writes.OUT}`);
  assert(
    r.messages[0].detail === "round↑(5 (X) / 2) * 10 = 30",
    `chain chat: ${r.messages[0].detail}`
  );
  const c = compileGraph(g, ["X", "OUT"]);
  assert(c.formulas.OUT === "(ceil((X / 2)) * 10)", `chain formula: ${c.formulas.OUT}`);
  assert(evalClosedFormula(c.formulas.OUT, { X: -5 }) === -20, "ceil(-2.5)*10 = -20");
}

// Formula macro: [x] / 2 → round(nearest) → [x]_half
{
  const g = {
    nodes: [
      { id: "src", kind: "field", field: "[x]", role: "source", x: 0, y: 0 },
      { id: "c2", kind: "const", value: 2, x: 0, y: 0 },
      { id: "div", kind: "op", op: "/", x: 0, y: 0 },
      { id: "r", kind: "op", op: "round", mode: "nearest", x: 0, y: 0 },
      { id: "out", kind: "field", field: "[x]_half", role: "output", x: 0, y: 0 },
    ],
    edges: [
      { id: "e1", from: "src", to: "div", toPort: 0 },
      { id: "e2", from: "c2", to: "div", toPort: 1 },
      { id: "e3", from: "div", to: "r", toPort: 0 },
      { id: "e4", from: "r", to: "out", toPort: 0 },
    ],
    collapsed: [
      { id: "c_half", name: "half", nodeIds: ["src", "c2", "div", "r", "out"], x: 0, y: 0 },
    ],
  };
  const fields = {
    HP: { type: "integer", default: 5 },
    HP_half: { type: "integer" },
    NEG: { type: "integer", default: -5 },
    NEG_half: { type: "integer" },
  };
  const c = compileGraph(g, fields);
  assert(!c.error, `macro compile: ${c.error}`);
  assert(c.formulas.HP_half === "round((HP / 2))", `macro formula: ${c.formulas.HP_half}`);
  assert(evalClosedFormula(c.formulas.HP_half, { HP: 5 }) === 3, "round(5/2)=3");
  assert(evalClosedFormula(c.formulas.NEG_half, { NEG: -5 }) === -2, "round(-5/2)=-2");
  const exp = expandFormulaMacrosForId(g, "HP");
  assert(exp.length === 1 && exp[0].formula === "round((HP / 2))", "expand macro for HP");
  // Live widget preview through macro expansion
  const w = { shape: "box", input_id: "HP", output_id: "HP_half", label: "HP" };
  const v = resolveWidgetValue(w, { liveValues: { HP: 7 }, schemaFields: fields, graph: g });
  assert(v === 4, `widget live value round(7/2)=4, got ${v}`);
  // Switching the mode on the same macro changes the result
  g.nodes[3].mode = "down";
  const v2 = resolveWidgetValue(w, { liveValues: { HP: 7 }, schemaFields: fields, graph: g });
  assert(v2 === 3, `widget live value floor(7/2)=3, got ${v2}`);
}

// Save/load round-trip preserves mode (JSON), old graph without round still compiles
{
  const saved = JSON.parse(JSON.stringify(roundGraph("up")));
  assert(saved.nodes[2].mode === "up", "mode survives JSON round-trip");
  assert(evaluateNamedFunction(saved, "rnd", { X: 1.1 }).writes.OUT === 2, "loaded up works");
}

console.log(`round-op: ${count} assertions OK`);
