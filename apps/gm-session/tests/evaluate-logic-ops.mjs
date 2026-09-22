/**
 * Logic ops, closed formulas, and entryValue for proficiency toggles.
 * Run: node apps/gm-session/tests/evaluate-logic-ops.mjs
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
const { evaluateNamedFunction, evalClosedFormula, arityOf } = sandbox.SheetRuntime;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(arityOf({ kind: "op", op: "if" }) === 3, "if arity 3");
assert(arityOf({ kind: "op", op: "not" }) === 1, "not arity 1");
assert(arityOf({ kind: "op", op: "and" }) === 2, "and arity 2");
assert(arityOf({ kind: "op", op: "==" }) === 2, "compare arity 2");
assert(arityOf({ kind: "op", op: "floor" }) === 1, "floor arity 1");

// --- Closed formula: comparisons + if/and/or/not ---
assert(evalClosedFormula("1 == 1", {}) === 1, "1==1");
assert(evalClosedFormula("1 == 2", {}) === 0, "1==2");
assert(evalClosedFormula("1 != 2", {}) === 1, "1!=2");
assert(evalClosedFormula("3 < 5", {}) === 1, "3<5");
assert(evalClosedFormula("5 > 3", {}) === 1, "5>3");
assert(evalClosedFormula("3 <= 3", {}) === 1, "3<=3");
assert(evalClosedFormula("4 >= 5", {}) === 0, "4>=5");
assert(evalClosedFormula("1 + 2 == 3", {}) === 1, "1+2==3 precedence");
assert(evalClosedFormula("2 * 3 > 5", {}) === 1, "2*3>5 precedence");
assert(evalClosedFormula("10 - 3 > 2 + 1", {}) === 1, "add vs compare precedence");
assert(evalClosedFormula("if(1, 10, 20)", {}) === 10, "if true");
assert(evalClosedFormula("if(0, 10, 20)", {}) === 20, "if false");
assert(evalClosedFormula("and(1, 1)", {}) === 1, "and(1,1)");
assert(evalClosedFormula("and(1, 0)", {}) === 0, "and(1,0)");
assert(evalClosedFormula("or(0, 1)", {}) === 1, "or(0,1)");
assert(evalClosedFormula("or(0, 0)", {}) === 0, "or(0,0)");
assert(evalClosedFormula("not(0)", {}) === 1, "not(0)");
assert(evalClosedFormula("not(5)", {}) === 0, "not(5)");
assert(evalClosedFormula("if(and(a, b), 1, 0)", { a: 1, b: 1 }) === 1, "if(and(a,b),1,0)");
assert(evalClosedFormula("if(and(a, b), 1, 0)", { a: 1, b: 0 }) === 0, "if(and) false");
assert(evalClosedFormula("a == b", { a: 3, b: 3 }) === 1, "a==b fields");
assert(evalClosedFormula("if(prof, PB, 0)", { prof: 1, PB: 3 }) === 3, "if(prof,PB,0) on");
assert(evalClosedFormula("if(prof, PB, 0)", { prof: 0, PB: 3 }) === 0, "if(prof,PB,0) off");
assert(
  evalClosedFormula("if(expertise, PB * 2, if(prof, PB, 0))", {
    expertise: 0,
    prof: 1,
    PB: 2,
  }) === 2,
  "expertise nested if"
);
assert(
  evalClosedFormula("if(expertise, PB * 2, if(prof, PB, 0))", {
    expertise: 1,
    prof: 1,
    PB: 2,
  }) === 4,
  "expertise on"
);

// --- Graph: == and or not if ---
// entry → (*0) → + ← ops so entry does not steal value ports (ancestor reachability)
function logicGraph() {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "logic" },
      { id: "fa", kind: "field", field: "A", role: "source" },
      { id: "fb", kind: "field", field: "B", role: "source" },
      { id: "eq", kind: "op", op: "==" },
      { id: "andn", kind: "op", op: "and" },
      { id: "orn", kind: "op", op: "or" },
      { id: "nt", kind: "op", op: "not" },
      { id: "iff", kind: "op", op: "if" },
      { id: "c1", kind: "const", value: 1 },
      { id: "c0", kind: "const", value: 0 },
      { id: "mul", kind: "op", op: "*" },
      { id: "add", kind: "op", op: "+" },
      { id: "out", kind: "field", field: "RESULT", role: "output" },
    ],
    edges: [
      // entry * 0 = 0, added to if-result for reachability without polluting ports
      { id: "t0", from: "e", to: "mul", toPort: 0 },
      { id: "t1", from: "c0", to: "mul", toPort: 1 },
      { id: "e1", from: "fa", to: "eq", toPort: 0 },
      { id: "e2", from: "fb", to: "eq", toPort: 1 },
      { id: "e3", from: "eq", to: "andn", toPort: 0 },
      { id: "e4", from: "fa", to: "andn", toPort: 1 },
      { id: "e5", from: "andn", to: "orn", toPort: 0 },
      { id: "e6", from: "c0", to: "orn", toPort: 1 },
      { id: "e7", from: "orn", to: "nt", toPort: 0 },
      { id: "e8", from: "nt", to: "iff", toPort: 0 },
      { id: "e9", from: "c0", to: "iff", toPort: 1 },
      { id: "e10", from: "c1", to: "iff", toPort: 2 },
      { id: "e11", from: "iff", to: "add", toPort: 0 },
      { id: "e12", from: "mul", to: "add", toPort: 1 },
      { id: "e13", from: "add", to: "out", toPort: 0 },
    ],
  };
}

const g = logicGraph();
const rEq = evaluateNamedFunction(g, "logic", { A: 2, B: 2 });
assert(rEq.ok, `logic eval: ${rEq.error}`);
assert(rEq.values.eq === 1, `== should be 1, got ${rEq.values.eq}`);
assert(rEq.values.andn === 1, `and should be 1, got ${rEq.values.andn}`);
assert(rEq.values.orn === 1, `or should be 1, got ${rEq.values.orn}`);
assert(rEq.values.nt === 0, `not should be 0, got ${rEq.values.nt}`);
assert(rEq.values.iff === 1, `if(falsy) → else=1, got ${rEq.values.iff}`);
assert(rEq.writes.RESULT === 1, `RESULT write 1, got ${rEq.writes.RESULT}`);

const rNeq = evaluateNamedFunction(g, "logic", { A: 1, B: 0 });
assert(rNeq.ok, `logic neq: ${rNeq.error}`);
assert(rNeq.values.eq === 0, `== false, got ${rNeq.values.eq}`);
assert(rNeq.values.andn === 0, "and false when eq=0");

// Skill-style: if(ath_prof, PB, 0) — entry*0 + if → out
const skill = {
  nodes: [
    { id: "e", kind: "entry", name: "athletics" },
    { id: "prof", kind: "field", field: "ath_prof", role: "source" },
    { id: "pb", kind: "field", field: "PB", role: "source" },
    { id: "z", kind: "const", value: 0 },
    { id: "iff", kind: "op", op: "if" },
    { id: "mul", kind: "op", op: "*" },
    { id: "add", kind: "op", op: "+" },
    { id: "out", kind: "field", field: "bonus", role: "output" },
  ],
  edges: [
    { id: "t0", from: "e", to: "mul", toPort: 0 },
    { id: "t1", from: "z", to: "mul", toPort: 1 },
    { id: "2", from: "prof", to: "iff", toPort: 0 },
    { id: "3", from: "pb", to: "iff", toPort: 1 },
    { id: "4", from: "z", to: "iff", toPort: 2 },
    { id: "5", from: "iff", to: "add", toPort: 0 },
    { id: "6", from: "mul", to: "add", toPort: 1 },
    { id: "7", from: "add", to: "out", toPort: 0 },
  ],
};
const sOn = evaluateNamedFunction(skill, "athletics", { ath_prof: 1, PB: 3 });
assert(sOn.ok, `skill on: ${sOn.error}`);
assert(sOn.values.iff === 3, `if on → 3, got ${sOn.values.iff}`);
assert(sOn.writes.bonus === 3, `skill on → bonus 3, got ${sOn.writes.bonus}`);
const sOff = evaluateNamedFunction(skill, "athletics", { ath_prof: 0, PB: 3 });
assert(sOff.ok && sOff.writes.bonus === 0, `skill off → 0, got ${sOff.writes.bonus}`);

// entryValue 0 vs 1 writing output field (toggle proficiency)
const toggleWrite = {
  nodes: [
    { id: "e", kind: "entry", name: "set_ath_prof" },
    { id: "out", kind: "field", field: "ath_prof", role: "output" },
  ],
  edges: [{ id: "1", from: "e", to: "out", toPort: 0 }],
};
const on = evaluateNamedFunction(toggleWrite, "set_ath_prof", {}, { entryValue: 1 });
assert(on.ok && on.writes.ath_prof === 1, `entryValue 1 → write 1, got ${on.writes.ath_prof}`);
const off = evaluateNamedFunction(toggleWrite, "set_ath_prof", {}, { entryValue: 0 });
assert(off.ok && off.writes.ath_prof === 0, `entryValue 0 → write 0, got ${off.writes.ath_prof}`);
const def = evaluateNamedFunction(toggleWrite, "set_ath_prof", {});
assert(def.ok && def.writes.ath_prof === 1, "default entryValue is 1");

console.log("OK evaluate-logic-ops: compare/and/or/not/if, formulas, entryValue");

// --- Resource adjust ops += / -= (same as + / - for formulas) ---
assert(arityOf({ kind: "op", op: "+=" }) === 2, "+= arity 2");
assert(arityOf({ kind: "op", op: "-=" }) === 2, "-= arity 2");

function adjustGraph(op) {
  return {
    nodes: [
      { id: "e", kind: "entry", name: "adj" },
      { id: "hp", kind: "field", field: "HP", role: "source" },
      { id: "d", kind: "const", value: 1 },
      { id: "op", kind: "op", op },
      { id: "z", kind: "const", value: 0 },
      { id: "mul", kind: "op", op: "*" },
      { id: "add", kind: "op", op: "+" },
      { id: "out", kind: "field", field: "HP", role: "output" },
    ],
    edges: [
      { id: "t0", from: "e", to: "mul", toPort: 0 },
      { id: "t1", from: "z", to: "mul", toPort: 1 },
      { id: "1", from: "hp", to: "op", toPort: 0 },
      { id: "2", from: "d", to: "op", toPort: 1 },
      { id: "3", from: "op", to: "add", toPort: 0 },
      { id: "4", from: "mul", to: "add", toPort: 1 },
      { id: "5", from: "add", to: "out", toPort: 0 },
    ],
  };
}
const rSub = evaluateNamedFunction(adjustGraph("-="), "adj", { HP: 10 });
assert(rSub.ok, `-= eval: ${rSub.error}`);
assert(rSub.writes.HP === 9, `HP-=1 → 9, got ${rSub.writes.HP}`);
const rAdd = evaluateNamedFunction(adjustGraph("+="), "adj", { HP: 10 });
assert(rAdd.ok, `+= eval: ${rAdd.error}`);
assert(rAdd.writes.HP === 11, `HP+=1 → 11, got ${rAdd.writes.HP}`);

console.log("evaluate-logic-ops: ok");
