(() => {
  "use strict";

  const ROLL_CHANNEL = "gm-session-roll";
  const ROLL_HISTORY_KEY = "gm-session-roll-history";

  const dieSidesEl = document.getElementById("die-sides");
  const btnDieRoll = document.getElementById("btn-die-roll");
  const bellMeanEl = document.getElementById("bell-mean");
  const bellStdevEl = document.getElementById("bell-stdev");
  const btnBellSample = document.getElementById("btn-bell-sample");
  const btnRollClear = document.getElementById("btn-roll-clear");
  const rollHistoryListEl = document.getElementById("roll-history-list");
  const statusEl = document.getElementById("status");

  /** @type {{label: string, result: number, detail: string, t?: number}[]} */
  const rollHistory = [];

  /** localStorage: shared across pywebview windows; cleared only via Clear. */
  function rollStore() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function readStoredHistory() {
    const store = rollStore();
    if (!store) return [];
    try {
      const raw = store.getItem(ROLL_HISTORY_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          label: String(e.label || ""),
          result: e.result,
          detail: String(e.detail || ""),
          t: typeof e.t === "number" ? e.t : undefined,
        }));
    } catch (_) {
      return [];
    }
  }

  function writeStoredHistory() {
    const store = rollStore();
    if (!store) return;
    try {
      store.setItem(ROLL_HISTORY_KEY, JSON.stringify(rollHistory));
    } catch (_) {}
  }

  function clearStoredHistory() {
    const store = rollStore();
    if (!store) return;
    try {
      store.removeItem(ROLL_HISTORY_KEY);
    } catch (_) {}
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Uniform integer from 1..sides inclusive. */
  function rollUniformInt(sides) {
    const n = Math.max(1, Math.floor(Number(sides) || 1));
    return 1 + Math.floor(Math.random() * n);
  }

  /** Box–Muller normal sample, rounded to nearest integer. */
  function sampleBell(mean, stdev) {
    const m = Number(mean);
    const s = Number(stdev);
    if (!(s > 0) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.round(m + z * s);
  }

  function renderRollHistory() {
    if (!rollHistoryListEl) return;
    rollHistoryListEl.innerHTML = "";
    if (rollHistory.length === 0) {
      const empty = document.createElement("div");
      empty.className = "roll-empty";
      empty.textContent = "No rolls yet";
      rollHistoryListEl.appendChild(empty);
      return;
    }
    for (const entry of rollHistory) {
      const line = document.createElement("div");
      line.className = "roll-line";
      line.innerHTML =
        `${escapeHtml(entry.label)} → <span class="roll-val">${escapeHtml(String(entry.result))}</span>` +
        (entry.detail
          ? ` <span style="color:var(--muted)">${escapeHtml(entry.detail)}</span>`
          : "");
      rollHistoryListEl.appendChild(line);
    }
    rollHistoryListEl.scrollTop = rollHistoryListEl.scrollHeight;
  }

  function entryKey(e) {
    return `${e.t ?? ""}|${e.label}|${e.result}|${e.detail || ""}`;
  }

  /**
   * Append a roll to in-memory history + localStorage and re-render.
   * Dedupes identical (t,label,result,detail) so BroadcastChannel + pywebview
   * bridges do not double-append the same sheet roll.
   */
  function appendRoll(label, result, detail, t) {
    const entry = {
      label: String(label || ""),
      result,
      detail: detail != null ? String(detail) : "",
      t: typeof t === "number" ? t : Date.now(),
    };
    const key = entryKey(entry);
    if (rollHistory.some((e) => entryKey(e) === key)) {
      return;
    }
    // Soft dedupe: same label/result/detail within 2s (BC + bridge race without t)
    for (let i = rollHistory.length - 1; i >= 0; i--) {
      const e = rollHistory[i];
      if (
        e.label === entry.label &&
        e.result === entry.result &&
        (e.detail || "") === (entry.detail || "")
      ) {
        const te = typeof e.t === "number" ? e.t : 0;
        if (!te || entry.t - te < 2000 || Date.now() - te < 2000) {
          return;
        }
      }
      if (typeof e.t === "number" && Date.now() - e.t > 5000) break;
    }
    rollHistory.push(entry);
    writeStoredHistory();
    renderRollHistory();
    setStatus(`${entry.label} → ${entry.result}`);
  }

  function hydrateFromStorage() {
    const stored = readStoredHistory();
    rollHistory.length = 0;
    for (const e of stored) {
      rollHistory.push(e);
    }
  }

  if (btnDieRoll) {
    btnDieRoll.addEventListener("click", () => {
      const sides = Math.max(1, Math.floor(Number(dieSidesEl && dieSidesEl.value) || 1));
      if (dieSidesEl) dieSidesEl.value = String(sides);
      const result = rollUniformInt(sides);
      appendRoll(`Dice 1–${sides}`, result, "");
    });
  }

  if (btnBellSample) {
    btnBellSample.addEventListener("click", () => {
      const mean = Number(bellMeanEl && bellMeanEl.value);
      const stdev = Number(bellStdevEl && bellStdevEl.value);
      const result = sampleBell(mean, stdev);
      if (result == null) {
        setStatus("Bell sample needs finite mean and σ > 0");
        return;
      }
      appendRoll(`Bell μ=${mean} σ=${stdev}`, result, "");
    });
  }

  if (btnRollClear) {
    btnRollClear.addEventListener("click", () => {
      rollHistory.length = 0;
      clearStoredHistory();
      renderRollHistory();
      setStatus("History cleared");
    });
  }

  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(ROLL_CHANNEL);
      ch.onmessage = (ev) => {
        const data = ev && ev.data;
        if (!data || typeof data !== "object") return;
        appendRoll(data.label, data.result, data.detail, data.t);
      };
    }
  } catch (_) {}

  window.__gmAppendRoll = appendRoll;

  hydrateFromStorage();
  renderRollHistory();
  setStatus("Ready");
})();
