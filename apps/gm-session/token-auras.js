/**
 * Token auras ("emanations"): up to 3 per actor, stored in actor appearance.auras
 * as { slot: 1..3, color: "#rrggbb", opacity: 0..1, enabled: bool }.
 * Radius is NOT stored here: it is the sheet field AURA<slot>_RADIUS, in grid
 * squares measured outward from the token's edge (5e-style emanation; 0 = no ring).
 */
(function (global) {
  "use strict";

  const AURA_MAX = 3;
  const AURA_FIELDS = ["AURA1_RADIUS", "AURA2_RADIUS", "AURA3_RADIUS"];
  const DEFAULT_COLORS = ["#4fc3f7", "#ffb74d", "#ba68c8"];
  const DEFAULT_OPACITY = 0.25;

  function auraField(slot) {
    return `AURA${slot}_RADIUS`;
  }

  function clamp01(n, dflt) {
    const v = Number(n);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(1, Math.max(0, v));
  }

  function normColor(c, slot) {
    const s = String(c || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    return DEFAULT_COLORS[(slot - 1) % DEFAULT_COLORS.length];
  }

  /** Tolerant load: old saves (missing/invalid) → []. Max 3, unique slots 1..3. */
  function normalizeAuras(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const used = new Set();
    for (const a of raw) {
      if (!a || typeof a !== "object") continue;
      let slot = Math.floor(Number(a.slot));
      if (!(slot >= 1 && slot <= AURA_MAX) || used.has(slot)) {
        slot = 0;
        for (let s = 1; s <= AURA_MAX; s++) {
          if (!used.has(s)) {
            slot = s;
            break;
          }
        }
      }
      if (!slot) break;
      used.add(slot);
      out.push({
        slot,
        color: normColor(a.color, slot),
        opacity: clamp01(a.opacity, DEFAULT_OPACITY),
        enabled: a.enabled !== false,
      });
      if (out.length >= AURA_MAX) break;
    }
    out.sort((x, y) => x.slot - y.slot);
    return out;
  }

  function canAddAura(list) {
    return normalizeAuras(list).length < AURA_MAX;
  }

  /** Add at the lowest free slot with distinct default color; returns null when full (3). */
  function addAura(list) {
    const cur = normalizeAuras(list);
    if (cur.length >= AURA_MAX) return null;
    const used = new Set(cur.map((a) => a.slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    cur.push({ slot, color: DEFAULT_COLORS[slot - 1], opacity: DEFAULT_OPACITY, enabled: true });
    cur.sort((x, y) => x.slot - y.slot);
    return cur;
  }

  function removeAura(list, slot) {
    return normalizeAuras(list).filter((a) => a.slot !== Number(slot));
  }

  /** Radius in squares from sheet field values (missing / negative / NaN → 0). */
  function auraRadiusSquares(fields, slot) {
    const v = Number(fields && fields[auraField(slot)]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /**
   * Rings the renderer draws (world units). gridSize = world px per grid square
   * (scene.grid.size — map layer scaling does not change the grid pitch).
   */
  function auraRings(auras, fields, sizeTiles, gridSize) {
    const size = Number(sizeTiles) > 0 ? Number(sizeTiles) : 1;
    const g = Number(gridSize) > 0 ? Number(gridSize) : 70;
    const rings = [];
    for (const a of normalizeAuras(auras)) {
      if (!a.enabled) continue;
      const sq = auraRadiusSquares(fields, a.slot);
      if (!(sq > 0)) continue;
      rings.push({
        slot: a.slot,
        color: a.color,
        opacity: a.opacity,
        squares: sq,
        radiusWorld: (size / 2 + sq) * g,
      });
    }
    // Largest first so smaller rings stay visible on top
    rings.sort((x, y) => y.radiusWorld - x.radiusWorld);
    return rings;
  }

  function rgba(hex, alpha) {
    const h = normColor(hex, 1).slice(1);
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
  }

  /** Seed missing AURA fields with 0 so Field nodes / formulas can read them. */
  function seedAuraFields(values) {
    for (const k of AURA_FIELDS) {
      if (values[k] === undefined || values[k] === null || values[k] === "") values[k] = 0;
    }
    return values;
  }

  /** Pick AURA field values out of a field map (for map live updates). */
  function pickAuraFields(values) {
    const out = {};
    for (const k of AURA_FIELDS) {
      const n = Number(values && values[k]);
      out[k] = Number.isFinite(n) ? n : 0;
    }
    return out;
  }

  const api = {
    AURA_MAX,
    AURA_FIELDS,
    DEFAULT_COLORS,
    DEFAULT_OPACITY,
    auraField,
    normalizeAuras,
    canAddAura,
    addAura,
    removeAura,
    auraRadiusSquares,
    auraRings,
    rgba,
    seedAuraFields,
    pickAuraFields,
  };
  global.TokenAuras = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
