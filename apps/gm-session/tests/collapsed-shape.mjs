/**
 * graph.collapsed shape round-trip + evaluate ignores collapsed metadata.
 * Run: node apps/gm-session/tests/collapsed-shape.mjs
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

function normalizeCollapsed(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const id = c.id != null ? String(c.id) : "c0";
    const name = c.name != null ? String(c.name) : "";
    const nodeIds = Array.isArray(c.nodeIds)
      ? c.nodeIds.map((x) => String(x)).filter(Boolean)
      : [];
    if (!nodeIds.length) continue;
    out.push({
      id,
      name,
      nodeIds,
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      w: c.w != null ? Number(c.w) : undefined,
      h: c.h != null ? Number(c.h) : undefined,
    });
  }
  return out;
}

const raw = [
  { id: "c1", name: "attack", nodeIds: ["e", "r"], x: 10, y: 20, w: 160, h: 80 },
  { id: "bad", name: "x", nodeIds: [] },
  null,
];
const norm = normalizeCollapsed(raw);
assert(norm.length === 1, "filters empty nodeIds");
assert(norm[0].id === "c1" && norm[0].name === "attack", "keeps id/name");
assert(norm[0].nodeIds.join(",") === "e,r", "nodeIds");
assert(norm[0].x === 10 && norm[0].w === 160, "geometry");

// Round-trip shape via JSON
const again = normalizeCollapsed(JSON.parse(JSON.stringify(norm)));
assert(JSON.stringify(again) === JSON.stringify(norm), "json round-trip");

const graph = {
  nodes: [
    { id: "e", kind: "entry", name: "attack" },
    { id: "r", kind: "roll", sides: 20 },
    { id: "chat", kind: "send_to_chat", label: "atk" },
  ],
  edges: [
    { id: "e1", from: "e", to: "r", toPort: 0 },
    { id: "e2", from: "r", to: "chat", toPort: 0 },
  ],
  collapsed: again,
};

const result = evaluateNamedFunction(graph, "attack", {});
assert(result.ok, "evaluate ok with collapsed present: " + (result.error || ""));
assert(Array.isArray(result.rolls) || Array.isArray(result.messages), "produces rolls/messages");

console.log("collapsed-shape: ok");
