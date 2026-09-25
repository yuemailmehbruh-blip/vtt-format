/**
 * 0.6.18: token image crop math (image-xform.js, shared with map layers),
 * auras (token-auras.js), AURAn_RADIUS through the sheet runtime, default template.
 * Run: node apps/gm-session/tests/token-crop-auras.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const sandbox = { console, Math, Number, String, Object, Array, Set, Map, Error, JSON };
sandbox.globalThis = sandbox;
sandbox.window = undefined;
for (const f of ["image-xform.js", "token-auras.js", "sheet-runtime.js"]) {
  vm.runInNewContext(readFileSync(join(APP, f), "utf8"), sandbox);
}
const IX = sandbox.ImageXform;
const TA = sandbox.TokenAuras;
const RT = sandbox.SheetRuntime;

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- Crop defaults (cover fit, centered) ---
let c = IX.defaultCrop(200, 100); // landscape 2:1
assert(near(c.h, 1) && near(c.w, 2), "landscape covers frame height");
assert(near(c.x, -0.5) && near(c.y, 0), "landscape centered");
c = IX.defaultCrop(100, 400);
assert(near(c.w, 1) && near(c.h, 4) && near(c.y, -1.5), "portrait covers width, centered");

// --- Snaps: each side moves one axis only; center moves both ---
const base = { x: 0.13, y: -0.27, w: 1.6, h: 1.2, flipX: false, flipY: true, rotation: 90 };
let s = IX.snapCrop(base, "left");
assert(near(s.x, 0) && near(s.y, base.y), "left: x=0, y untouched");
s = IX.snapCrop(base, "right");
assert(near(s.x + s.w, 1) && near(s.y, base.y), "right: right edge = frame edge, y untouched");
s = IX.snapCrop(base, "top");
assert(near(s.y, 0) && near(s.x, base.x), "top: y=0, x untouched");
s = IX.snapCrop(base, "bottom");
assert(near(s.y + s.h, 1) && near(s.x, base.x), "bottom: bottom edge = frame edge, x untouched");
s = IX.snapCrop(IX.snapCrop(base, "left"), "bottom");
assert(near(s.x, 0) && near(s.y + s.h, 1), "left then bottom keeps both");
s = IX.snapCrop(base, "center");
assert(near(s.x + s.w / 2, 0.5) && near(s.y + s.h / 2, 0.5), "center both axes");
assert(s.w === base.w && s.h === base.h && s.flipY && s.rotation === 90, "snap keeps size/flip/rotation");
assert(base.x === 0.13, "snap does not mutate input");

// --- Zoom about pivot / pan ---
let z = IX.zoomCrop({ x: 0, y: 0, w: 1, h: 1 }, 2);
assert(near(z.w, 2) && near(z.x, -0.5) && near(z.y, -0.5), "zoom 2x about center");
z = IX.zoomCrop({ x: 0, y: 0, w: 1, h: 2 }, 0.5, 0, 0);
assert(near(z.w, 0.5) && near(z.h, 1) && near(z.x, 0), "zoom keeps aspect, pivot fixed");
const p = IX.panCrop({ x: 0.1, y: 0.2, w: 1, h: 1 }, 0.05, -0.1);
assert(near(p.x, 0.15) && near(p.y, 0.1), "pan");

// --- Shared Scale / Flip / Rotate (same helpers the map layers use) ---
const layer = { x: 70, y: 140, w: 700, h: 350, rotation: 0 };
IX.rotateCw(layer);
assert(layer.w === 350 && layer.h === 700 && layer.rotation === 90 && layer.x === 70, "map rotate swaps w/h, keeps top-left");
IX.rotateCw(layer); IX.rotateCw(layer); IX.rotateCw(layer);
assert(layer.rotation === 0 && layer.w === 700, "4 rotations = identity");
IX.toggleFlip(layer, "h");
assert(layer.flipX === true && !layer.flipY, "flip h");
IX.toggleFlip(layer, "v"); IX.toggleFlip(layer, "h");
assert(!layer.flipX && layer.flipY, "flip v / unflip h");
const r = IX.scaleToTiles(layer, 12, 8, 70);
assert(layer.w === 840 && layer.h === 560 && r.tw === 12 && r.th === 8, "map scale H/V tiles");
IX.scaleToTiles(layer, 0.1, 0, 70);
assert(layer.w === 35 && layer.h === 35, "map scale min 0.5 tile");

const crop = { x: -0.5, y: 0, w: 2, h: 1, flipX: false, flipY: false, rotation: 0 };
IX.rotateCw(crop, { keepCenter: true });
assert(near(crop.w, 1) && near(crop.h, 2) && near(crop.x, 0) && near(crop.y, -0.5) && crop.rotation === 90, "crop rotate keeps center");
// token 2 tiles across: 3×3 tiles = 1.5 frame units
IX.scaleToTiles(crop, 3, 3, 1 / 2, { min: 0.05, keepCenter: true });
assert(near(crop.w, 1.5) && near(crop.h, 1.5) && near(crop.x + 0.75, 0.5) && near(crop.y + 0.75, 0.5), "crop scale in tiles, centered");

// --- Persistence round-trip (offset, scale, flip, rotation) ---
const edited = { x: -0.123456789, y: 0.25, w: 1.75, h: 2.5, flipX: true, flipY: false, rotation: 270 };
const json = JSON.parse(JSON.stringify(IX.cropToJSON(edited)));
const back = IX.normalizeCrop(json);
assert(near(back.x, edited.x, 1e-6) && near(back.y, 0.25) && near(back.w, 1.75) && near(back.h, 2.5), "round-trip offset/scale");
assert(back.flipX === true && back.flipY === false && back.rotation === 270, "round-trip flip/rotation");
assert(IX.normalizeCrop({ x: 0, y: 0, w: 1, h: 1, rotation: -90 }).rotation === 270, "rotation normalized");
assert(IX.normalizeCrop(null) === null && IX.normalizeCrop({ w: 0, h: 1 }) === null, "invalid crop → null (white circle)");
const sr = IX.cropScreenRect(back, 100, 50, 80);
assert(near(sr.x, 100 + back.x * 80) && near(sr.w, 140), "screen rect scales with frame (any zoom)");

// --- Auras: max 3, slots, defaults, old saves ---
assert(TA.normalizeAuras(undefined).length === 0, "old save (no auras) → []");
assert(TA.normalizeAuras("junk").length === 0, "garbage → []");
let list = [];
for (let i = 0; i < 3; i++) {
  list = TA.addAura(list);
  assert(list && list.length === i + 1, `add aura ${i + 1}`);
}
assert(new Set(list.map((a) => a.color)).size === 3, "distinct default colors");
assert(list.map((a) => a.slot).join() === "1,2,3", "slots 1..3");
assert(TA.addAura(list) === null && !TA.canAddAura(list), "4th aura blocked");
const five = TA.normalizeAuras([{}, {}, {}, {}, {}]);
assert(five.length === 3, "normalize truncates to 3");
list = TA.removeAura(list, 2);
assert(list.map((a) => a.slot).join() === "1,3", "remove slot 2");
list = TA.addAura(list);
assert(list.map((a) => a.slot).join() === "1,2,3", "re-add reuses lowest free slot");
const clamp = TA.normalizeAuras([{ slot: 1, opacity: 7, color: "red" }])[0];
assert(clamp.opacity === 1 && /^#[0-9a-f]{6}$/.test(clamp.color) && clamp.enabled === true, "opacity clamp, color fallback");

// Rings: radius from edge, grid pitch, 0 → none, disabled → none
const auras = [
  { slot: 1, color: "#ff0000", opacity: 0.3, enabled: true },
  { slot: 2, color: "#00ff00", opacity: 0.5, enabled: true },
  { slot: 3, color: "#0000ff", opacity: 0.5, enabled: false },
];
let rings = TA.auraRings(auras, { AURA1_RADIUS: 2, AURA2_RADIUS: 0, AURA3_RADIUS: 5 }, 1, 70);
assert(rings.length === 1 && rings[0].slot === 1, "only enabled, radius > 0");
assert(rings[0].radiusWorld === (0.5 + 2) * 70, "1-tile token, 2 squares → 2.5 * grid");
rings = TA.auraRings(auras, { AURA1_RADIUS: 1 }, 2, 100);
assert(rings[0].radiusWorld === (1 + 1) * 100, "2-tile token on 100px grid");
assert(TA.rgba("#ff8000", 0.25) === "rgba(255, 128, 0, 0.25)", "rgba");

// --- Runtime: automations read/write AURA1_RADIUS like any field ---
const setGraph = {
  nodes: [
    { id: "e", kind: "entry", name: "grow_aura" },
    { id: "src", kind: "field", field: "AURA1_RADIUS", role: "source" },
    { id: "one", kind: "const", value: 1 },
    { id: "op", kind: "op", op: "+=" },
    { id: "z", kind: "const", value: 0 },
    { id: "mul", kind: "op", op: "*" },
    { id: "add", kind: "op", op: "+" },
    { id: "out", kind: "field", field: "AURA1_RADIUS", role: "output" },
    { id: "e2", kind: "entry", name: "set_aura2" },
    { id: "c3", kind: "const", value: 3 },
    { id: "z2", kind: "const", value: 0 },
    { id: "mul2", kind: "op", op: "*" },
    { id: "add2", kind: "op", op: "+" },
    { id: "out2", kind: "field", field: "AURA2_RADIUS", role: "output" },
  ],
  edges: [
    { id: "a", from: "e", to: "mul", toPort: 0 },
    { id: "b", from: "z", to: "mul", toPort: 1 },
    { id: "c", from: "src", to: "op", toPort: 0 },
    { id: "d", from: "one", to: "op", toPort: 1 },
    { id: "f", from: "op", to: "add", toPort: 0 },
    { id: "g", from: "mul", to: "add", toPort: 1 },
    { id: "h", from: "add", to: "out", toPort: 0 },
    { id: "i", from: "e2", to: "mul2", toPort: 0 },
    { id: "j", from: "z2", to: "mul2", toPort: 1 },
    { id: "k", from: "c3", to: "add2", toPort: 0 },
    { id: "l", from: "mul2", to: "add2", toPort: 1 },
    { id: "m", from: "add2", to: "out2", toPort: 0 },
  ],
};
// Sheet seeds missing AURA fields at 0 (sheet.js recomputeLive / TA.seedAuraFields)
const fields = TA.seedAuraFields({});
assert(fields.AURA1_RADIUS === 0 && fields.AURA3_RADIUS === 0, "seeded 0");
let res = RT.evaluateNamedFunction(setGraph, "grow_aura", fields);
assert(res.ok && res.writes.AURA1_RADIUS === 1, `AURA1 += 1 → 1 (${res.error})`);
Object.assign(fields, res.writes);
res = RT.evaluateNamedFunction(setGraph, "grow_aura", fields);
Object.assign(fields, res.writes);
assert(fields.AURA1_RADIUS === 2, "AURA1 += 1 twice → 2");
res = RT.evaluateNamedFunction(setGraph, "set_aura2", fields);
Object.assign(fields, res.writes);
assert(fields.AURA2_RADIUS === 3, "AURA2 set to 3");
// What the map renderer reads after the sheet publishes the fields
const published = TA.pickAuraFields(fields);
rings = TA.auraRings(auras.map((a) => ({ ...a, enabled: true })), published, 1, 70);
const bySlot = Object.fromEntries(rings.map((x) => [x.slot, x.radiusWorld]));
assert(bySlot[1] === 2.5 * 70 && bySlot[2] === 3.5 * 70 && !bySlot[3], "renderer radii follow automation writes");
// Formula use: AURA1_RADIUS readable in closed formulas
assert(RT.evalClosedFormula("AURA1_RADIUS * 5", { AURA1_RADIUS: 2 }) === 10, "formula reads AURA field");
// Compile-safe automation (same rule as every field: entry-fed outputs use a [x]
// template; a button with function_id "bump_AURA1" supplies the ID) → writes AURA1_RADIUS.
const macroGraph = {
  nodes: [
    { id: "e", kind: "entry", name: "bump_[x]" },
    { id: "src", kind: "field", field: "[x]_RADIUS", role: "source" },
    { id: "one", kind: "const", value: 1 },
    { id: "op", kind: "op", op: "+=" },
    { id: "z", kind: "const", value: 0 },
    { id: "mul", kind: "op", op: "*" },
    { id: "add", kind: "op", op: "+" },
    { id: "out", kind: "field", field: "[x]_RADIUS", role: "output" },
  ],
  edges: setGraph.edges.slice(0, 7),
};
const compiledMacro = RT.compileGraph(macroGraph, Object.keys(fields));
assert(!compiledMacro.error, `aura [x] automation compiles: ${compiledMacro.error}`);
res = RT.evaluateNamedFunction(macroGraph, "bump_AURA3", fields);
assert(res.ok && res.writes.AURA3_RADIUS === 1, `button bump_AURA3 → AURA3_RADIUS=1 (${res.error})`);
// Formula-driven aura (Field output fed by a formula) compiles like any field
const formulaGraph = {
  nodes: [
    { id: "lv", kind: "field", field: "Level", role: "source" },
    { id: "two", kind: "const", value: 2 },
    { id: "div", kind: "op", op: "/" },
    { id: "fl", kind: "op", op: "floor" },
    { id: "o", kind: "field", field: "AURA2_RADIUS", role: "output" },
  ],
  edges: [
    { id: "1", from: "lv", to: "div", toPort: 0 },
    { id: "2", from: "two", to: "div", toPort: 1 },
    { id: "3", from: "div", to: "fl", toPort: 0 },
    { id: "4", from: "fl", to: "o", toPort: 0 },
  ],
};
const compiledFormula = RT.compileGraph(formulaGraph, ["Level", ...TA.AURA_FIELDS]);
assert(!compiledFormula.error && compiledFormula.formulas.AURA2_RADIUS, "aura formula compiles");
assert(RT.evalClosedFormula(compiledFormula.formulas.AURA2_RADIUS, { Level: 7 }) === 3, "AURA2_RADIUS = floor(Level/2)");

// --- Default player-sheet template compiles with the runtime; auras coexist ---
const tpl = JSON.parse(readFileSync(join(APP, "defaults", "player-sheet.builder.json"), "utf8"));
assert(Object.keys(tpl.fields).length > 0 && tpl.layout.widgets.length > 0 && tpl.graph.nodes.length > 0, "template has fields/layout/graph");
const tplCompiled = RT.compileGraph(tpl.graph, tpl.fields);
assert(tplCompiled && !tplCompiled.error, `template compiles: ${tplCompiled && tplCompiled.error}`);
for (const k of TA.AURA_FIELDS) assert(!(k in tpl.fields), `template does not own ${k}`);
// Add the aura automation to the template graph (as a user would): still compiles, no conflicts
const merged = {
  nodes: [...tpl.graph.nodes, ...macroGraph.nodes.map((n) => ({ ...n, id: `aura_${n.id}` }))],
  edges: [
    ...tpl.graph.edges,
    ...macroGraph.edges.map((e) => ({ ...e, id: `aura_${e.id}`, from: `aura_${e.from}`, to: `aura_${e.to}` })),
  ],
  collapsed: tpl.graph.collapsed || [],
};
const mergedCompiled = RT.compileGraph(merged, { ...tpl.fields });
assert(!mergedCompiled.error, `template + aura automation compiles: ${mergedCompiled.error}`);
for (const k of TA.AURA_FIELDS) assert(!(mergedCompiled.formulas || {})[k], `${k} not formula-owned (automation writes stay writable)`);
const env = TA.seedAuraFields({});
const tres = RT.evaluateNamedFunction(merged, "bump_AURA2", env);
assert(tres.ok && tres.writes.AURA2_RADIUS === 1, `aura automation runs on template-based sheet (${tres.error})`);
const tplAttack = RT.evaluateNamedFunction(merged, "attack_STR", { ...env, STAT_PHYS_STR_mod: 2, Proficiency: 2 });
assert(tplAttack.ok, `template attack_[x] still runs: ${tplAttack.error}`);
// Template's own named functions still resolve
const tplYaml = readFileSync(join(APP, "defaults", "player-sheet.yaml"), "utf8");
assert(/^id: player$/m.test(tplYaml) || /\nid: player\n/.test(tplYaml), "yaml snapshot is the player sheet");

console.log(`token-crop-auras: ok (${count} assertions)`);
