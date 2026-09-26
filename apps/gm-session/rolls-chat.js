/* 0.7.2: the shared "Rolls & Chat" component (markup + behaviour), used unchanged by
 * the GM's pop-out window (rolls.html / rolls.js) and by the player's sidebar
 * (session.js in player mode), styled by rolls-chat.css. The host supplies the
 * transport: post(body) → {ok, entry?, epoch?, error?}, and feeds chat data with
 * merge({epoch, seq, entries}). Messages are rendered with textContent only.
 *
 * Rolls: "Dice" (1..N, uniform) and "Bell curve" (normal, rounded), each with a
 * per-roll constant modifier (any +/- integer). A modified roll is posted as e.g.
 * label "1d20 + 3", result 17, detail "14 + 3 = 17". Sheet-triggered rolls are not
 * affected (they post their own label/result).
 */
(function (global) {
  "use strict";

  const TEMPLATE = `
  <div class="rc-head"><strong>Rolls &amp; Chat</strong><span class="rc-note">shared with every player</span></div>
  <div class="rc-body">
    <div class="rc-section">
      <h3>Dice roll</h3>
      <div class="rc-fields">
        <label for="die-sides">1–</label>
        <input type="number" id="die-sides" min="1" step="1" value="20" title="Sides" />
        <label for="die-mod">+</label>
        <input type="number" id="die-mod" class="rc-mod" step="1" value="0" title="Constant added to the roll (negative to subtract)" />
        <button type="button" class="rc-primary" id="btn-die-roll">Roll</button>
      </div>
    </div>
    <div class="rc-section">
      <h3>Bell curve sample</h3>
      <div class="rc-fields">
        <label for="bell-mean">μ</label>
        <input type="number" id="bell-mean" step="any" value="10" />
        <label for="bell-stdev">σ</label>
        <input type="number" id="bell-stdev" min="0.0001" step="any" value="3" />
        <label for="bell-mod">+</label>
        <input type="number" id="bell-mod" class="rc-mod" step="1" value="0" title="Constant added to the sample (negative to subtract)" />
        <button type="button" class="rc-primary" id="btn-bell-sample">Sample</button>
      </div>
    </div>
    <div class="rc-section rc-history">
      <div class="rc-history-head">
        <h3>Session chat</h3>
        <button type="button" class="rc-ghost" id="btn-roll-clear" title="Clear the shared session chat (moved to the campaign trash)">Clear</button>
      </div>
      <div class="rc-list" id="roll-history-list" aria-live="polite"></div>
      <form class="rc-form" id="chat-form" autocomplete="off">
        <input type="text" id="chat-input" maxlength="500" placeholder="Message everyone…" />
        <button type="submit" class="rc-primary" id="chat-send">Send</button>
      </form>
    </div>
  </div>
  <div class="rc-actions"><span class="rc-status" id="rc-status"></span></div>`;

  function rollUniformInt(sides, rnd) {
    const n = Math.max(1, Math.floor(Number(sides) || 1));
    return 1 + Math.floor((rnd || Math.random)() * n);
  }

  function sampleBell(mean, stdev, rnd) {
    const r = rnd || Math.random;
    const m = Number(mean);
    const s = Number(stdev);
    if (!(s > 0) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
    let u = 0;
    let v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.round(m + z * s);
  }

  /** Parse the modifier box: any integer (clamped to ±1e6), blank/invalid → 0. */
  function parseMod(v) {
    const n = Math.trunc(Number(String(v == null ? "" : v).trim() || 0));
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1e6, Math.min(1e6, n));
  }

  function modText(mod) {
    return mod ? ` ${mod < 0 ? "−" : "+"} ${Math.abs(mod)}` : "";
  }

  /** Chat body for a roll of `base` with constant `mod`. */
  function rollBody(labelBase, base, mod) {
    const total = base + mod;
    return {
      kind: "roll",
      label: `${labelBase}${modText(mod)}`,
      result: total,
      detail: mod ? `${base}${modText(mod)} = ${total}` : "",
    };
  }

  function fmtTime(ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  /**
   * mount(el, {post, canClear, onClear, emptyText}) → controller.
   * el receives class "rc" and the component markup.
   */
  function mount(el, opts) {
    const o = opts || {};
    el.classList.add("rc");
    el.innerHTML = TEMPLATE;
    const $ = (id) => el.querySelector(`#${id}`);
    const listEl = $("roll-history-list");
    const statusEl = $("rc-status");
    const input = $("chat-input");
    const clearBtn = $("btn-roll-clear");
    if (!o.canClear && clearBtn) clearBtn.hidden = true;
    let entries = [];
    let seq = null;
    let epoch = null;

    function setStatus(msg) {
      statusEl.textContent = msg || "";
    }

    function render() {
      const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      listEl.innerHTML = "";
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "roll-empty";
        empty.textContent = o.emptyText || "No rolls or messages yet";
        listEl.appendChild(empty);
        return;
      }
      for (const e of entries) {
        const line = document.createElement("div");
        line.className = `roll-line ${e.kind === "roll" ? "roll" : "msg"} ${(e.sender && e.sender.role) || ""}`;
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = fmtTime(e.t);
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
            d.textContent = ` (${e.detail})`;
            line.append(d);
          }
        } else {
          line.append(document.createTextNode(e.text || ""));
        }
        listEl.appendChild(line);
      }
      if (nearBottom || entries.length < 3) listEl.scrollTop = listEl.scrollHeight;
    }

    /** Feed chat data ({epoch, seq, entries}); a new epoch (chat cleared) resets the list. */
    function merge(d) {
      if (!d) return;
      if (d.epoch !== epoch) entries = [];
      const have = new Set(entries.map((e) => e.seq));
      for (const e of d.entries || []) if (!have.has(e.seq)) entries.push(e);
      entries.sort((a, b) => a.seq - b.seq);
      entries = entries.slice(-500);
      seq = typeof d.seq === "number" ? d.seq : seq;
      epoch = d.epoch;
      render();
    }

    async function send(body) {
      let r;
      try {
        r = await o.post(body);
      } catch (err) {
        r = { ok: false, error: String(err) };
      }
      if (!r || !r.ok) {
        setStatus(`Not sent: ${(r && r.error) || "server unreachable"}`);
        return false;
      }
      if (r.entry) merge({ epoch: r.epoch || epoch, seq: Math.max(seq || 0, r.entry.seq), entries: [r.entry] });
      return true;
    }

    $("btn-die-roll").addEventListener("click", () => {
      const sidesEl = $("die-sides");
      const sides = Math.max(1, Math.floor(Number(sidesEl.value) || 1));
      sidesEl.value = String(sides);
      const mod = parseMod($("die-mod").value);
      $("die-mod").value = String(mod);
      send(rollBody(`1d${sides}`, rollUniformInt(sides), mod));
    });
    $("btn-bell-sample").addEventListener("click", () => {
      const mean = Number($("bell-mean").value);
      const stdev = Number($("bell-stdev").value);
      const base = sampleBell(mean, stdev);
      if (base == null) {
        setStatus("Bell sample needs finite mean and σ > 0");
        return;
      }
      const mod = parseMod($("bell-mod").value);
      $("bell-mod").value = String(mod);
      send(rollBody(`Bell μ=${mean} σ=${stdev}`, base, mod));
    });
    $("chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      const ok = await send({ kind: "message", text });
      input.disabled = false;
      if (ok) input.value = "";
      input.focus();
    });
    if (clearBtn && o.canClear) {
      clearBtn.addEventListener("click", () => o.onClear && o.onClear(setStatus));
    }
    render();
    return {
      merge,
      setStatus,
      render,
      get seq() {
        return seq;
      },
      get epoch() {
        return epoch;
      },
    };
  }

  const api = { mount, rollBody, parseMod, rollUniformInt, sampleBell };
  global.RollsChat = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
