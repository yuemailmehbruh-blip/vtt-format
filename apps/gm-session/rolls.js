(() => {
  "use strict";

  const dieSidesEl = document.getElementById("die-sides");
  const btnDieRoll = document.getElementById("btn-die-roll");
  const bellMeanEl = document.getElementById("bell-mean");
  const bellStdevEl = document.getElementById("bell-stdev");
  const btnBellSample = document.getElementById("btn-bell-sample");
  const btnRollClear = document.getElementById("btn-roll-clear");
  const rollHistoryListEl = document.getElementById("roll-history-list");
  const statusEl = document.getElementById("status");

  /** @type {{label: string, result: number, detail: string}[]} */
  const rollHistory = [];

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

  function appendRoll(label, result, detail) {
    rollHistory.push({ label, result, detail: detail || "" });
    renderRollHistory();
    setStatus(`${label} → ${result}`);
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
      renderRollHistory();
      setStatus("History cleared");
    });
  }

  renderRollHistory();
  setStatus("Ready");
})();
