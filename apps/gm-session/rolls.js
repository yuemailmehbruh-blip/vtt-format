(() => {
  "use strict";
  // 0.7.1: the Rolls window shows the shared session chat (authoritative log on
  // this GM server, state/chat/session.jsonl). Rolls and messages posted here, by
  // sheets (GM or player) and by players all land in the same log; this window
  // long-polls /api/chat so new lines appear immediately.

  const dieSidesEl = document.getElementById("die-sides");
  const btnDieRoll = document.getElementById("btn-die-roll");
  const bellMeanEl = document.getElementById("bell-mean");
  const bellStdevEl = document.getElementById("bell-stdev");
  const btnBellSample = document.getElementById("btn-bell-sample");
  const btnRollClear = document.getElementById("btn-roll-clear");
  const listEl = document.getElementById("roll-history-list");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");

  let entries = [];
  let seq = 0;
  let epoch = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function rollUniformInt(sides) {
    const n = Math.max(1, Math.floor(Number(sides) || 1));
    return 1 + Math.floor(Math.random() * n);
  }

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

  /** textContent only: nothing from a message is ever parsed as HTML. */
  function render() {
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
    listEl.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "roll-empty";
      empty.textContent = "No rolls or messages yet";
      listEl.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const line = document.createElement("div");
      line.className = `roll-line ${(e.sender && e.sender.role) || ""}`;
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = (e.sender && e.sender.name) || "?";
      line.append(time, who);
      if (e.kind === "roll") {
        line.append(document.createTextNode(`${e.label || "roll"} → `));
        const v = document.createElement("span");
        v.className = "roll-val";
        v.textContent = String(e.result);
        line.append(v);
        if (e.detail) {
          const d = document.createElement("span");
          d.className = "det";
          d.textContent = ` ${e.detail}`;
          line.append(d);
        }
      } else {
        line.append(document.createTextNode(e.text || ""));
      }
      listEl.appendChild(line);
    }
    if (nearBottom || entries.length < 3) listEl.scrollTop = listEl.scrollHeight;
  }

  function merge(d) {
    if (d.epoch !== epoch) entries = [];
    const have = new Set(entries.map((e) => e.seq));
    for (const e of d.entries || []) if (!have.has(e.seq)) entries.push(e);
    entries.sort((a, b) => a.seq - b.seq);
    entries = entries.slice(-500);
    seq = d.seq || 0;
    epoch = d.epoch;
    render();
  }

  async function post(body) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      setStatus(`Not sent: ${(data && data.error) || "server unreachable"}`);
      return false;
    }
    if (data.entry) merge({ epoch: data.epoch || epoch, seq: Math.max(seq, data.entry.seq), entries: [data.entry] });
    return true;
  }

  async function loop() {
    let wait = 0;
    for (;;) {
      try {
        const q = epoch === null ? "after=0" : `after=${seq}&epoch=${encodeURIComponent(epoch)}`;
        const res = await fetch(`/api/chat?${q}&wait=${wait}`);
        if (!res.ok) throw new Error(String(res.status));
        merge(await res.json());
        wait = 20;
        setStatus("Live");
      } catch (_) {
        setStatus("Reconnecting…");
        await sleep(2000);
      }
    }
  }

  if (btnDieRoll) {
    btnDieRoll.addEventListener("click", () => {
      const sides = Math.max(1, Math.floor(Number(dieSidesEl && dieSidesEl.value) || 1));
      if (dieSidesEl) dieSidesEl.value = String(sides);
      post({ kind: "roll", label: `Dice 1–${sides}`, result: rollUniformInt(sides), detail: "" });
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
      post({ kind: "roll", label: `Bell μ=${mean} σ=${stdev}`, result, detail: "" });
    });
  }
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (await post({ kind: "message", text })) input.value = "";
      input.focus();
    });
  }
  if (btnRollClear) {
    btnRollClear.addEventListener("click", async () => {
      if (!window.confirm("Clear the session chat for everyone? (The old log is kept in the campaign trash.)")) return;
      const res = await fetch("/api/chat", { method: "DELETE" }).catch(() => null);
      setStatus(res && res.ok ? "Chat cleared" : "Clear failed");
    });
  }

  // Sheets post rolls straight to /api/chat; the old desktop bridge call is a no-op now.
  window.__gmAppendRoll = () => {};
  render();
  loop();
})();
