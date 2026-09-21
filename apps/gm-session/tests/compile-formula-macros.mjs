/**
 * Formula macros: no-entry collapsed groups with [x] bind against doc.fields.
 * Run: node apps/gm-session/tests/compile-formula-macros.mjs
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
const { compileGraph, bindMacroId, evalClosedFormula } = sandbox.SheetRuntime;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(bindMacroId("[x]_mod", "STR_mod") === "STR", "STR bind");
assert(bindMacroId("[x]_mod", "DEX_mod") === "DEX", "DEX bind");
assert(bindMacroId("[x]_mod", "STR") == null, "no false bind");
assert(bindMacroId("mod_[x]", "mod_STR") === "STR", "prefix bind");

/** [x] - 10 / 2 floor → [x]_mod */
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

const fields = {
  STR: { type: "integer", default: 10 },
  STR_mod: { type: "integer" },
  DEX: { type: "integer", default: 14 },
  DEX_mod: { type: "integer" },
};

const graph = abilityModMacroGraph();
const compiled = compileGraph(graph, fields);
assert(!compiled.error, `compile error: ${compiled.error}`);
assert(
  compiled.formulas.STR_mod === "floor(((STR - 10) / 2))",
  `STR_mod formula: ${compiled.formulas.STR_mod}`
);
assert(
  compiled.formulas.DEX_mod === "floor(((DEX - 10) / 2))",
  `DEX_mod formula: ${compiled.formulas.DEX_mod}`
);
assert(compiled.formulas["[x]_mod"] == null, "template key must not be written");

assert(evalClosedFormula(compiled.formulas.STR_mod, { STR: 10 }) === 0, "STR 10 → 0");
assert(evalClosedFormula(compiled.formulas.STR_mod, { STR: 18 }) === 4, "STR 18 → 4");
assert(evalClosedFormula(compiled.formulas.DEX_mod, { DEX: 14 }) === 2, "DEX 14 → 2");

// Two macros claiming same F → error
const dup = abilityModMacroGraph();
dup.collapsed.push({
  id: "c2",
  name: "other_mod",
  nodeIds: ["src", "c10", "sub", "c2", "div", "fl", "out"],
  x: 0,
  y: 0,
});
const bad = compileGraph(dup, fields);
assert(bad.error && /both claim field STR_mod/.test(bad.error), `dup error: ${bad.error}`);

// Collapsed with entry is NOT a formula macro (no [x] expansion from collapse)
const withEntry = abilityModMacroGraph();
withEntry.nodes.push({ id: "e", kind: "entry", name: "f_[x]", x: 0, y: 0 });
withEntry.collapsed[0].nodeIds.push("e");
withEntry.collapsed[0].name = "f_[x]";
const noMacro = compileGraph(withEntry, fields);
assert(!noMacro.error, noMacro.error);
assert(noMacro.formulas.STR_mod == null, "entry collapse must not expand as formula macro");

console.log("compile-formula-macros: ok");

// --- STAT_[x]_base / STAT_[x]_mod (0.6.15) ---
function statAbilityModMacroGraph() {
  return {
    nodes: [
      { id: "src", kind: "field", field: "STAT_[x]_base", role: "source", x: 0, y: 0 },
      { id: "c10", kind: "const", value: 10, x: 0, y: 0 },
      { id: "sub", kind: "op", op: "-", x: 0, y: 0 },
      { id: "c2", kind: "const", value: 2, x: 0, y: 0 },
      { id: "div", kind: "op", op: "/", x: 0, y: 0 },
      { id: "fl", kind: "op", op: "floor", x: 0, y: 0 },
      { id: "out", kind: "field", field: "STAT_[x]_mod", role: "output", x: 0, y: 0 },
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
        id: "c_stat_mod",
        name: "stat_ability_mod",
        nodeIds: ["src", "c10", "sub", "c2", "div", "fl", "out"],
        x: 0,
        y: 0,
      },
    ],
  };
}

const statFields = {
  STAT_STR_base: { type: "integer", default: 10 },
  STAT_STR_mod: { type: "integer" },
  STAT_DEX_base: { type: "integer", default: 14 },
  STAT_DEX_mod: { type: "integer" },
};
const statGraph = statAbilityModMacroGraph();
const statCompiled = compileGraph(statGraph, statFields);
assert(!statCompiled.error, `stat compile error: ${statCompiled.error}`);
assert(
  statCompiled.formulas.STAT_STR_mod === "floor(((STAT_STR_base - 10) / 2))",
  `STAT_STR_mod formula: ${statCompiled.formulas.STAT_STR_mod}`
);
assert(
  statCompiled.formulas.STAT_DEX_mod === "floor(((STAT_DEX_base - 10) / 2))",
  `STAT_DEX_mod: ${statCompiled.formulas.STAT_DEX_mod}`
);
assert(statCompiled.formulas.STAT_STR_base == null, "base must not be a formula key");
assert(bindMacroId("STAT_[x]_mod", "STAT_STR_mod") === "STR", "STAT bind ID=STR");
assert(bindMacroId("STAT_[x]_base", "STAT_STR_base") === "STR", "base bind ID=STR");

// Optional: second macro STAT_[x]_final = base+mod with unique node ids
function withFinalMacro(baseGraph) {
  const g = JSON.parse(JSON.stringify(baseGraph));
  g.nodes.push(
    { id: "f_base", kind: "field", field: "STAT_[x]_base", role: "source", x: 0, y: 0 },
    { id: "f_mod", kind: "field", field: "STAT_[x]_mod", role: "source", x: 0, y: 0 },
    { id: "f_add", kind: "op", op: "+", x: 0, y: 0 },
    { id: "f_out", kind: "field", field: "STAT_[x]_final", role: "output", x: 0, y: 0 }
  );
  g.edges.push(
    { id: "fe1", from: "f_base", to: "f_add", toPort: 0 },
    { id: "fe2", from: "f_mod", to: "f_add", toPort: 1 },
    { id: "fe3", from: "f_add", to: "f_out", toPort: 0 }
  );
  g.collapsed.push({
    id: "c_stat_final",
    name: "stat_final",
    nodeIds: ["f_base", "f_mod", "f_add", "f_out"],
    x: 0,
    y: 0,
  });
  return g;
}

const fieldsWithFinal = {
  ...statFields,
  STAT_STR_final: { type: "integer" },
  STAT_DEX_final: { type: "integer" },
};
const both = compileGraph(withFinalMacro(statGraph), fieldsWithFinal);
assert(!both.error, `both macros: ${both.error}`);
assert(
  both.formulas.STAT_STR_mod === "floor(((STAT_STR_base - 10) / 2))",
  "mod still present"
);
assert(
  both.formulas.STAT_STR_final === "(STAT_STR_base + STAT_STR_mod)",
  `final formula: ${both.formulas.STAT_STR_final}`
);

// Document: short template STAT_[x] claiming STAT_STR_mod collides with STAT_[x]_mod
// (both claim field STAT_STR_mod) — existing claim error is fine.
{
  const collide = statAbilityModMacroGraph();
  collide.nodes.push(
    { id: "short_src", kind: "const", value: 0, x: 0, y: 0 },
    { id: "short_out", kind: "field", field: "STAT_[x]", role: "output", x: 0, y: 0 }
  );
  collide.edges.push({ id: "se1", from: "short_src", to: "short_out", toPort: 0 });
  collide.collapsed.push({
    id: "c_short",
    name: "stat_short",
    nodeIds: ["short_src", "short_out"],
    x: 0,
    y: 0,
  });
  // STAT_STR_mod binds to STAT_[x] with ID=STR_mod AND to STAT_[x]_mod with ID=STR
  const badShort = compileGraph(collide, statFields);
  assert(
    badShort.error && /both claim field STAT_STR_mod/.test(badShort.error),
    `short STAT_[x] collision documented: ${badShort.error}`
  );
}

console.log("compile-formula-macros (STAT_[x]): ok");
