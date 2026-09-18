/**
 * Display widgets: migrate field→id/label + resolve receive via formula macro.
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
  widgetLabel,
  widgetDisplayId,
  widgetUid,
  expandFormulaMacrosForId,
  evalClosedFormula,
  compileGraph,
} = sandbox.SheetRuntime;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- migrate legacy field ---
const legacy = migrateDisplayWidget(
  { id: "w_m5xk_1", shape: "box", field: "STR", x: 0, y: 0, w: 72, h: 56 },
  { STR: { type: "integer", default: 10 } },
  () => "w_new_uid"
);
assert(legacy.uid === "w_m5xk_1", `uid: ${legacy.uid}`);
assert(legacy.id === "STR", `display id: ${legacy.id}`);
assert(legacy.label === "STR", `label: ${legacy.label}`);
assert(legacy.field === "STR", `field alias: ${legacy.field}`);
assert(legacy.value_mode === "create", `mode: ${legacy.value_mode}`);
assert(widgetUid(legacy) === "w_m5xk_1", "widgetUid");
assert(widgetDisplayId(legacy) === "STR", "widgetDisplayId");
assert(widgetLabel(legacy) === "STR", "widgetLabel");

const legacyMod = migrateDisplayWidget(
  { id: "w_abc_2", shape: "circle", field: "STR_mod", x: 0, y: 0, w: 64, h: 64 },
  { STR_mod: { type: "integer", formula: "floor((STR - 10) / 2)" } }
);
assert(legacyMod.value_mode === "receive", `mod mode: ${legacyMod.value_mode}`);
assert(legacyMod.id === "STR_mod" && legacyMod.label === "STR_mod", "mod id/label");

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

// create box: ID=STR Label=STR
const createW = {
  uid: "w_1",
  id: "STR",
  label: "STR",
  field: "STR",
  value_mode: "create",
  shape: "box",
};
assert(
  resolveWidgetValue(createW, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 } },
    graph,
  }) === 18,
  "create resolves live STR"
);

// receive box: ID=STR Label=STR_mod (formula on schema)
const recvMod = {
  uid: "w_2",
  id: "STR",
  label: "STR_mod",
  field: "STR_mod",
  value_mode: "receive",
  shape: "circle",
};
assert(
  resolveWidgetValue(recvMod, {
    liveValues: { STR: 18, STR_mod: 4 },
    schemaFields: {
      STR: { type: "integer", default: 10 },
      STR_mod: { type: "integer", formula: "floor((STR - 10) / 2)" },
    },
    graph,
  }) === 4,
  "receive STR_mod from live/formula"
);

// receive via macro when formula missing on schema
assert(
  resolveWidgetValue(recvMod, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 }, STR_mod: { type: "integer" } },
    graph,
  }) === 4,
  "receive STR_mod via macro expand"
);

// receive ID=STR Label=STR → show derived mod (macro primary output)
const recvSame = {
  uid: "w_3",
  id: "STR",
  label: "STR",
  field: "STR",
  value_mode: "receive",
  shape: "circle",
};
assert(
  resolveWidgetValue(recvSame, {
    liveValues: { STR: 18 },
    schemaFields: { STR: { type: "integer", default: 10 } },
    graph,
  }) === 4,
  "receive label===id shows STR_mod via macro"
);

// compile still binds when fields present
const compiled = compileGraph(graph, {
  STR: {},
  STR_mod: {},
});
assert(!compiled.error, compiled.error);
assert(compiled.formulas.STR_mod, "compile writes STR_mod");

console.log("display-widget-id-label: ok");
