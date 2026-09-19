/**
 * Display widgets: migrate → label/input_id/output_id + display fallback.
 * Run: node apps/gm-session/tests/display-widget-id-label.mjs
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
const {
  migrateDisplayWidget,
  resolveWidgetValue,
  widgetHasOutputValue,
  widgetCaption,
  widgetInputId,
  widgetOutputId,
  widgetUid,
  expandFormulaMacrosForId,
  evalClosedFormula,
  compileGraph,
  unwrapBracketIdent,
  isValidCompileName,
} = sandbox.SheetRuntime;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- migrate legacy field-only ---
const legacy = migrateDisplayWidget(
  { id: "w_m5xk_1", shape: "box", field: "STR", x: 0, y: 0, w: 72, h: 56 },
  { STR: { type: "integer", default: 10 } },
  () => "w_new_uid"
);
assert(legacy.uid === "w_m5xk_1", `uid: ${legacy.uid}`);
assert(legacy.input_id === "STR", `input_id: ${legacy.input_id}`);
assert(legacy.output_id === "STR", `output_id: ${legacy.output_id}`);
assert(legacy.label === "STR", `label: ${legacy.label}`);
assert(legacy.field === "STR", `field alias: ${legacy.field}`);
assert(legacy.value_mode === undefined, "value_mode removed");
assert(widgetUid(legacy) === "w_m5xk_1", "widgetUid");
assert(widgetCaption(legacy) === "STR", "widgetCaption");
assert(widgetInputId(legacy) === "STR", "widgetInputId");

// Legacy field with formula (pure formula key)
const legacyMod = migrateDisplayWidget(
  { id: "w_abc_2", shape: "circle", field: "STR_mod", x: 0, y: 0, w: 64, h: 64 },
  { STR_mod: { type: "integer", formula: "floor((STR - 10) / 2)" } }
);
assert(legacyMod.input_id === "STR_mod" && legacyMod.output_id === "STR_mod", "mod ids");
assert(legacyMod.label === "STR_mod", "mod label");

// --- migrate 0.6.13 receive: id=caption, label=automation ---
const recv613 = migrateDisplayWidget(
  {
    uid: "w_r",
    id: "STR",
    label: "STR_mod",
    field: "STR_mod",
    value_mode: "receive",
    shape: "circle",
  },
  {}
);
assert(recv613.input_id === "STR", `recv input ${recv613.input_id}`);
assert(recv613.output_id === "STR_mod", `recv output ${recv613.output_id}`);
assert(recv613.label === "STR", `recv caption ${recv613.label}`);
assert(recv613.field === "STR", "recv field=input");
assert(recv613.value_mode === undefined, "recv no value_mode");

// --- migrate 0.6.13 create ---
const create613 = migrateDisplayWidget(
  {
    uid: "w_c",
    id: "STR",
    label: "STR",
    field: "STR",
    value_mode: "create",
    shape: "box",
  },
  {}
);
assert(create613.input_id === "STR" && create613.output_id === "STR", "create ids");
assert(create613.label === "STR", "create label");

// Already dual-value: keep
const dual = migrateDisplayWidget(
  {
    uid: "w_d",
    label: "Strength",
    input_id: "STR",
    output_id: "STR_mod",
    shape: "box",
  },
  {}
);
assert(dual.label === "Strength" && dual.input_id === "STR" && dual.output_id === "STR_mod", "keep dual");

// --- unwrapBracketIdent leftover ---
assert(typeof unwrapBracketIdent === "function", "unwrapBracketIdent exported");
{
  const a = unwrapBracketIdent("[STR]");
  assert(a.unwrapped === true && a.value === "STR", `unwrap [STR]: ${JSON.stringify(a)}`);
  const d = unwrapBracketIdent("[x]_mod");
  assert(d.unwrapped === false && d.value === "[x]_mod", `keep [x]_mod`);
  assert(isValidCompileName("[x]_mod"), "[x]_mod still valid");
  assert(!isValidCompileName("[STR]"), "[STR] invalid until unwrap");
}

// --- ability_mod macro graph ---
function abilityModMacroGraph() {
  return {
    nodes: [
      { id: "src", kind: "field", field: "[x]", role: "source", x: 0, y: 0 },
      { id: "c10", kind: "const", value: 10, x: 0, y: 0 },
      { id: "sub", kind: "op", op: "-", x: 0, y: 0 },
      { id: "c2", kind: "const", value: 2, x: 0, y: 0 },
      { id: "div", kind: "op", op: "/", x: 0, y: 0 },
      { id: "fl", kind: "op", op: "floor", x: 0, y: 0 },
      { id: "out", kind: "field", field: "[x]_mod", role: "output", x: 0, y: 0 },
    ],
    edges: [
      { id: "e1", from: "src", to: "sub", toPort: 0 },
      { id: "e2", from: "c10", to: "sub", toPort: 1 },
      { id: "e3", from: "sub", to: "div", toPort: 0 },
      { id: "e4", from: "c2", to: "div", toPort: 1 },
      { id: "e5", from: "div", to: "fl", toPort: 0 },
      { id: "e6", from: "fl", to: "out", toPort: 0 },
    ],
    collapsed: [
      {
        id: "c_macro",
        name: "ability_mod",
        nodeIds: ["src", "c10", "sub", "c2", "div", "fl", "out"],
        x: 0,
        y: 0,
      },
    ],
  };
}

const graph = abilityModMacroGraph();
const expanded = expandFormulaMacrosForId(graph, "STR");
assert(expanded.length === 1, `expand len ${expanded.length}`);
assert(expanded[0].outputName === "STR_mod", expanded[0].outputName);
assert(
  evalClosedFormula(expanded[0].formula, { STR: 18 }) === 4,
  "expand eval STR 18 → 4"
);

// Dual widget: Label Strength, Input STR, Output STR_mod
const strengthW = {
  uid: "w_1",
  label: "Strength",
  input_id: "STR",
  output_id: "STR_mod",
  field: "STR",
  shape: "box",
};

assert(
  resolveWidgetValue(strengthW, {
    liveValues: { STR: 18, STR_mod: 4 },
    schemaFields: {
      STR: { type: "integer", default: 10 },
      STR_mod: { type: "integer", formula: "floor((STR - 10) / 2)" },
    },
    graph,
  }) === 4,
  "display STR_mod from formula/live"
);

assert(
  widgetHasOutputValue(strengthW, {
    liveValues: { STR: 18 },
    schemaFields: {
      STR: { type: "integer", default: 10 },
      STR_mod: { type: "integer", formula: "floor((STR - 10) / 2)" },
    },
    graph,
  }) === true,
  "has output when formula on STR_mod"
);

// Macro path when formula missing on schema
assert(
  resolveWidgetValue(strengthW, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 }, STR_mod: { type: "integer" } },
    graph,
  }) === 4,
  "display STR_mod via macro expand"
);

// Fallback to input when no output automation
const plainW = {
  uid: "w_2",
  label: "Strength",
  input_id: "STR",
  output_id: "STR",
  field: "STR",
  shape: "box",
};
assert(
  resolveWidgetValue(plainW, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 } },
    graph,
  }) === 18,
  "fallback to input when output===input and no formula"
);

assert(
  widgetHasOutputValue(plainW, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 } },
    graph,
  }) === false,
  "no output when same key without formula"
);

// output set but unresolved → fallback to input
const dangling = {
  uid: "w_3",
  label: "Strength",
  input_id: "STR",
  output_id: "MISSING_mod",
  shape: "box",
};
assert(
  resolveWidgetValue(dangling, {
    liveValues: { STR: 14 },
    schemaFields: { STR: { type: "integer", default: 10 }, MISSING_mod: { type: "integer" } },
    graph,
  }) === 14,
  "fallback when output key has no formula/macro"
);

// compile still binds when fields present
const compiled = compileGraph(graph, {
  STR: {},
  STR_mod: {},
});
assert(!compiled.error, compiled.error);
assert(compiled.formulas.STR_mod, "compile writes STR_mod");

console.log("display-widget-id-label: ok");
