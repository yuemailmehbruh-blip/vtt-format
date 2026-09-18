/**
 * Documents toggle field flip semantics (sheet.js runToggleField).
 * Toggle does not call evaluateNamedFunction; it flips actor field 0/1.
 * Run: node apps/gm-session/tests/toggle-field-flip.mjs
 */
function nextToggleValue(cur) {
  // missing/nonfinite → treat as 0 (off); nonzero finite → on
  const n = Number(cur);
  const on = Number.isFinite(n) && n !== 0;
  return on ? 0 : 1;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(nextToggleValue(undefined) === 1, "missing → 1");
assert(nextToggleValue(null) === 1, "null → 1");
assert(nextToggleValue(NaN) === 1, "NaN → 1");
assert(nextToggleValue("x") === 1, "nonfinite → 1");
assert(nextToggleValue(0) === 1, "0 → 1");
assert(nextToggleValue(1) === 0, "1 → 0");
assert(nextToggleValue(5) === 0, "5 → 0");
assert(nextToggleValue(-2) === 0, "-2 → 0");
console.log("toggle-field-flip: ok");
