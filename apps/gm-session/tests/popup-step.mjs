/**
 * 0.7.3 pop-up step node: instance variables for one run, cancel, ordering, templates,
 * toggle entries, compile rejection inside formula macros, old graphs unchanged.
 * Run: node apps/gm-session/tests/popup-step.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, "..", "sheet-runtime.js"), "utf8");
const sandbox = { console, Math, Number, String, Object, Array, Set, Map, Error, Promise, JSON };
sandbox.globalThis = sandbox;
sandbox.window = undefined;
vm.runInNewContext(code, sandbox);
const RT = sandbox.SheetRuntime;
let n = 0;
function assert(c, m) { if (!c) throw new Error("FAIL: " + m); n++; }

// entry → popup(bonus) ; roll d20 ; + ; chat (arith) — "d20 + popup value"
function g(extra) {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "strike", x: 0, y: 0 },
      { id: "p", kind: "popup", prompt: "Situational bonus", var: "bonus", vtype: "number", default: 2, x: 150, y: 80 },
      { id: "r", kind: "roll", sides: 20, x: 150, y: 0 },
      { id: "add", kind: "op", op: "+", x: 300, y: 40 },
      { id: "c", kind: "send_to_chat", label: "Strike +{bonus}", include_arithmetic: true, x: 450, y: 40 },
      ...(extra || []),
    ],
    edges: [
      { id: "1", from: "e", to: "r", toPort: 0 },
      { id: "2", from: "e", to: "p", toPort: 0 },
      { id: "3", from: "r", to: "add", toPort: 0 },
      { id: "4", from: "p", to: "add", toPort: 1 },
      { id: "5", from: "add", to: "c", toPort: 0 },
    ],
  };
}

const found = RT.popupsForRun(g(), "strike");
assert(found.popups.length === 1 && found.popups[0].var === "bonus" && found.popups[0].default === 2, "popup listed with spec");

// async run with an answer
let asked = [];
let res = await RT.runNamedFunctionAsync(g(), "strike", { HP: 10 }, { prompt: async (spec) => { asked.push(spec.prompt); return 5; } });
assert(res.ok && asked.length === 1 && asked[0] === "Situational bonus", "prompt called once");
const roll = res.rolls[0].result;
assert(res.messages.length === 1 && res.messages[0].value === roll + 5, "d20 + popup value");
assert(res.messages[0].text === "Strike +5", "chat label substitutes {bonus}");
assert(res.messages[0].detail === `${roll} (d20) + 5 (bonus) = ${roll + 5}`, "arithmetic shows the instance variable: " + res.messages[0].detail);
assert(Object.keys(res.writes).length === 0, "nothing written");

// cancel → no rolls/messages/writes, flagged cancelled
let rolled = 0;
const origRand = sandbox.Math.random;
res = await RT.runNamedFunctionAsync(g(), "strike", {}, { prompt: async () => null });
assert(!res.ok && res.cancelled === true && res.rolls.length === 0 && res.messages.length === 0 && Object.keys(res.writes).length === 0, "cancel aborts cleanly");

// sync evaluate (old callers) uses the default
res = RT.evaluateNamedFunction(g(), "strike", {});
assert(res.ok && res.messages[0].value === res.rolls[0].result + 2, "sync evaluate uses popup default");

// instance var readable by a same-named field node, and NEVER written even if an output node targets it
const g2 = g([
  { id: "fsrc", kind: "field", field: "bonus", role: "source", x: 300, y: 200 },
  { id: "dbl", kind: "op", op: "*", x: 400, y: 200 },
  { id: "outHP", kind: "field", field: "last_bonus_x2", role: "output", x: 500, y: 200 },
  { id: "outVar", kind: "field", field: "bonus", role: "output", x: 500, y: 260 },
]);
g2.edges.push({ id: "6", from: "fsrc", to: "dbl", toPort: 0 }, { id: "7", from: "e", to: "dbl", toPort: 1 },
  { id: "8", from: "dbl", to: "outHP", toPort: 0 }, { id: "9", from: "dbl", to: "outVar", toPort: 0 });
res = await RT.runNamedFunctionAsync(g2, "strike", { bonus: 99 }, { prompt: async () => 4 });
assert(res.ok && res.writes.last_bonus_x2 === 4, "field node named like the var reads the instance value (not the sheet's 99)");
assert(!("bonus" in res.writes), "instance variable never written to the sheet");

// multiple pop-ups: chained one first, then top-to-bottom
const g3 = {
  nodes: [
    { id: "e", kind: "entry", name: "multi", x: 0, y: 0 },
    { id: "pB", kind: "popup", prompt: "B", var: "b", x: 100, y: 10 },
    { id: "pA", kind: "popup", prompt: "A", var: "a", x: 100, y: 200 },
    { id: "pC", kind: "popup", prompt: "C (after A)", var: "c", x: 100, y: 0 },
    { id: "s1", kind: "op", op: "+", x: 200, y: 0 },
    { id: "s2", kind: "op", op: "-", x: 300, y: 0 },
    { id: "ch", kind: "send_to_chat", label: "", x: 400, y: 0 },
  ],
  edges: [
    { id: "1", from: "e", to: "pA", toPort: 0 }, { id: "2", from: "e", to: "pB", toPort: 0 },
    { id: "3", from: "pA", to: "pC", toPort: 0 },
    { id: "4", from: "pA", to: "s1", toPort: 0 }, { id: "5", from: "pB", to: "s1", toPort: 1 },
    { id: "6", from: "s1", to: "s2", toPort: 0 }, { id: "7", from: "pC", to: "s2", toPort: 1 },
    { id: "8", from: "s2", to: "ch", toPort: 0 },
  ],
};
asked = [];
const answers = { a: 10, b: 3, c: 1 };
res = await RT.runNamedFunctionAsync(g3, "multi", {}, { prompt: async (spec, info) => { asked.push(`${spec.var}:${info.index + 1}/${info.total}`); return answers[spec.var]; } });
assert(asked.join(",") === "b:1/3,a:2/3,c:3/3", "order: top-to-bottom, chained after its upstream pop-up: " + asked.join(","));
assert(res.ok && res.messages[0].value === 12, "a + b - c = 12");
// cancel on the 2nd
asked = [];
res = await RT.runNamedFunctionAsync(g3, "multi", {}, { prompt: async (spec, info) => (info.index === 1 ? null : 1) });
assert(res.cancelled && res.messages.length === 0, "cancel on second pop-up aborts the whole run");

// text + choice types
const g4 = {
  nodes: [
    { id: "e", kind: "entry", name: "say", x: 0, y: 0 },
    { id: "t", kind: "popup", prompt: "Target", var: "target", vtype: "text", default: "goblin", x: 100, y: 0 },
    { id: "ch", kind: "popup", prompt: "Mode", var: "mode", vtype: "choice", choices: "Advantage=2\nNormal=0\nDisadvantage=-2", x: 100, y: 50 },
    { id: "c", kind: "send_to_chat", label: "Hits {target} ({mode})", x: 300, y: 0 },
  ],
  edges: [{ id: "1", from: "e", to: "t", toPort: 0 }, { id: "2", from: "e", to: "ch", toPort: 0 }, { id: "3", from: "ch", to: "c", toPort: 0 }],
};
const spec = RT.popupsForRun(g4, "say").popups;
assert(spec[1].type === "choice" && spec[1].choices.length === 3 && spec[1].default === 2, "choice spec parsed; default = first choice");
res = await RT.runNamedFunctionAsync(g4, "say", {}, { prompt: async (s) => (s.type === "text" ? "orc" : -2) });
assert(res.ok && res.messages[0].text === "Hits orc (Disadvantage)" && res.messages[0].value === -2, "text + choice values: " + res.messages[0].text);

// [x] template instantiates popup strings
const g5 = {
  nodes: [
    { id: "e", kind: "entry", name: "check_[x]", x: 0, y: 0 },
    { id: "p", kind: "popup", prompt: "Bonus for [x]", var: "b", x: 0, y: 0 },
    { id: "f", kind: "field", field: "[x]", role: "source", x: 0, y: 0 },
    { id: "a", kind: "op", op: "+", x: 0, y: 0 },
    { id: "c", kind: "send_to_chat", label: "", x: 0, y: 0 },
  ],
  edges: [{ id: "1", from: "e", to: "p", toPort: 0 }, { id: "2", from: "f", to: "a", toPort: 0 }, { id: "3", from: "p", to: "a", toPort: 1 }, { id: "4", from: "a", to: "c", toPort: 0 }],
};
asked = [];
res = await RT.runNamedFunctionAsync(g5, "check_STR", { STR: 3 }, { prompt: async (s) => { asked.push(s.prompt); return 4; } });
assert(asked[0] === "Bonus for STR" && res.messages[0].value === 7, "template [x] substituted in pop-up prompt");

// toggle entries
const tg = { nodes: [{ id: "e", kind: "entry", name: "rage", mode: "toggle" }, { id: "e2", kind: "entry", name: "attack" }], edges: [] };
assert(RT.entryModeFor(tg, "rage") === "toggle" && RT.entryModeFor(tg, "attack") === "trigger" && RT.entryModeFor(tg, "nope") === null, "entryModeFor");

// formula macro containing a pop-up → compile explains why
const macro = {
  nodes: [
    { id: "p", kind: "popup", var: "q" },
    { id: "o", kind: "field", field: "[x]_mod", role: "output" },
  ],
  edges: [{ id: "1", from: "p", to: "o", toPort: 0 }],
  collapsed: [{ id: "c", name: "m", nodeIds: ["p", "o"] }],
};
const comp = RT.compileGraph(macro, ["STR", "STR_mod"]);
assert(comp.error && /Pop-up/.test(comp.error), "pop-up inside a formula macro is a clear compile error");

// pop-up inside a compressed FUNCTION block works (collapsed is layout only)
const gc = g();
gc.collapsed = [{ id: "c1", name: "strike", nodeIds: gc.nodes.map((x) => x.id), x: 0, y: 0, w: 300, h: 120 }];
res = await RT.runNamedFunctionAsync(gc, "strike", {}, { prompt: async () => 1 });
assert(res.ok && res.messages[0].value === res.rolls[0].result + 1, "pop-up inside a compressed function");

// old graphs (no pop-ups): async path == sync path shape, no prompt calls
const old = { nodes: [{ id: "e", kind: "entry", name: "hp" }, { id: "k", kind: "const", value: 3 }, { id: "o", kind: "field", field: "HP", role: "output" }, { id: "a", kind: "op", op: "+=" }, { id: "f", kind: "field", field: "HP" }],
  edges: [{ id: "1", from: "f", to: "a", toPort: 0 }, { id: "2", from: "k", to: "a", toPort: 1 }, { id: "3", from: "a", to: "o", toPort: 0 }, { id: "4", from: "e", to: "a", toPort: 5 }] };
let calls = 0;
res = await RT.runNamedFunctionAsync(old, "hp", { HP: 4 }, { prompt: async () => { calls++; return 1; } });
assert(res.ok && calls === 0 && res.writes.HP === 7 && res.popupCount === 0, "no pop-ups: no prompts, same result");
assert(RT.arityOf({ kind: "popup" }) === 1, "popup has one 'after' input port");
console.log(`popup-step: ok (${n} checks)`);
