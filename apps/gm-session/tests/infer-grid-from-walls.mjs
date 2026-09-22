/**
 * Wall-grid proposal helpers (synthetic segments).
 * Run: node apps/gm-session/tests/infer-grid-from-walls.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, "..", "infer-grid-from-walls.js"), "utf8");
const sandbox = { console, Math, Number, String, Object, Array, Set, Map, Float64Array, Float32Array, Uint8Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const {
  collapseParallelSegments,
  scoreWallGrid,
  proposeGridFromWalls,
} = sandbox.InferGridFromWalls;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Double-line walls ~3px apart → one centerline
const doubles = [
  { x1: 10, y1: 50, x2: 200, y2: 50, orient: "h", length: 190 },
  { x1: 10, y1: 53, x2: 200, y2: 53, orient: "h", length: 190 },
  { x1: 80, y1: 10, x2: 80, y2: 180, orient: "v", length: 170 },
  { x1: 83, y1: 10, x2: 83, y2: 180, orient: "v", length: 170 },
];
const collapsed = collapseParallelSegments(doubles, 4);
assert(collapsed.length === 2, `expected 2 centerlines, got ${collapsed.length}`);
const h = collapsed.find((s) => s.orient === "h");
const v = collapsed.find((s) => s.orient === "v");
assert(h && Math.abs(h.y1 - 51.5) < 0.01, `h mid ~51.5 got ${h && h.y1}`);
assert(v && Math.abs(v.x1 - 81.5) < 0.01, `v mid ~81.5 got ${v && v.x1}`);

// Perfect grid walls at pitch 70, phase 10
const pitch = 70;
const phase = 10;
const segs = [];
for (let k = 0; k < 6; k++) {
  const y = phase + k * pitch;
  segs.push({ x1: 0, y1: y, x2: 400, y2: y, orient: "h", length: 400 });
  const x = phase + k * pitch;
  segs.push({ x1: x, y1: 0, x2: x, y2: 400, orient: "v", length: 400 });
}
const score = scoreWallGrid(segs, pitch, phase, phase, 2.5);
assert(score > 0.99, `perfect walls score ${score}`);

const proposed = proposeGridFromWalls(segs, 20, 120);
assert(proposed, "should propose a grid");
assert(Math.abs(proposed.pitch - pitch) < 1.5, `pitch ~70 got ${proposed.pitch}`);
assert(proposed.score > 0.5, `score >50% got ${proposed.score}`);

// Wrong pitch on perfect walls scores worse than the true pitch
const wrong = scoreWallGrid(segs, 33, phase, phase, 2);
assert(wrong < score, `wrong pitch ${wrong} should be < true ${score}`);
assert(wrong < 0.5, `wrong pitch should be under 50%, got ${wrong}`);

// Empty → null
assert(proposeGridFromWalls([], 20, 100) == null, "empty segments → null");


console.log("infer-grid-from-walls: ok");
