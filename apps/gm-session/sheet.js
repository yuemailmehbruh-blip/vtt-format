(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const actorId = params.get("actor");
  const titleEl = document.getElementById("title");
  const pathEl = document.getElementById("path");
  const textEl = document.getElementById("sheet-text");
  const statusEl = document.getElementById("status");
  const appearanceStatusEl = document.getElementById("appearance-status");
  const sizeTilesEl = document.getElementById("size-tiles");
  const panelSheet = document.getElementById("panel-sheet");
  const panelAppearance = document.getElementById("panel-appearance");
  const svgEl = document.getElementById("sheet-svg");
  const rollToastEl = document.getElementById("roll-toast");
  const notesBlock = document.getElementById("notes-block");

  /** @type {any} */
  let appearance = { size_tiles: 1 };
  /** @type {Record<string, any>} */
  let schemaFields = {};
  /** @type {Record<string, any>} */
  let actorFields = {};
  /** @type {object[]} */
  let widgets = [];
  /** @type {Record<string, number|string>} */
  let liveValues = {};

  const APPEARANCE_CHANNEL = "gm-session-appearance";
  const ROLL_CHANNEL = "gm-session-roll";
  const ROLL_HISTORY_KEY = "gm-session-roll-history";

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setAppearanceStatus(msg) {
    appearanceStatusEl.textContent = msg || "";
  }

  function switchTab(name) {
    const isSheet = name === "sheet";
    panelSheet.classList.toggle("active", isSheet);
    panelAppearance.classList.toggle("active", !isSheet);
    for (const btn of document.querySelectorAll(".tabs button")) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function notifyMap(actor, app) {
    const payload = { actor_id: actor, appearance: app };
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const ch = new BroadcastChannel(APPEARANCE_CHANNEL);
        ch.postMessage(payload);
        ch.close();
      }
    } catch (_) {}

    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.appearance_saved === "function"
        ? window.pywebview.api
        : null;
    if (api) {
      Promise.resolve(api.appearance_saved(actor, app)).catch(() => {});
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Closed formula language: identifiers, numbers, + - * /, parentheses, floor(...).
   * @param {string} expr
   * @param {Record<string, number>} env
   */
  function evalClosedFormula(expr, env) {
    const src = String(expr || "").trim();
    if (!src) return NaN;
    let i = 0;

    function peek() {
      while (i < src.length && /\s/.test(src[i])) i++;
      return src[i];
    }

    function match(ch) {
      if (peek() === ch) {
        i++;
        return true;
      }
      return false;
    }

    function parseIdent() {
      peek();
      const start = i;
      if (!/[A-Za-z_]/.test(src[i] || "")) return null;
      i++;
      while (/[A-Za-z0-9_]/.test(src[i] || "")) i++;
      return src.slice(start, i);
    }

    function parseNumber() {
      peek();
      const start = i;
      if (!/[0-9.]/.test(src[i] || "")) return null;
      while (/[0-9]/.test(src[i] || "")) i++;
      if (src[i] === ".") {
        i++;
        while (/[0-9]/.test(src[i] || "")) i++;
      }
      const n = Number(src.slice(start, i));
      return Number.isFinite(n) ? n : null;
    }

    function parsePrimary() {
      peek();
      if (match("(")) {
        const v = parseExpr();
        if (!match(")")) throw new Error("expected )");
        return v;
      }
      const ident = parseIdent();
      if (ident) {
        if (ident === "floor") {
          if (!match("(")) throw new Error("floor expects (");
          const v = parseExpr();
          if (!match(")")) throw new Error("expected )");
          return Math.floor(v);
        }
        const raw = env[ident];
        const n = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(n) ? n : 0;
      }
      const num = parseNumber();
      if (num != null) return num;
      throw new Error("unexpected token at " + i);
    }

    function parseUnary() {
      peek();
      if (match("-")) return -parseUnary();
      if (match("+")) return parseUnary();
      return parsePrimary();
    }

    function parseTerm() {
      let v = parseUnary();
      for (;;) {
        peek();
        if (match("*")) v *= parseUnary();
        else if (match("/")) {
          const d = parseUnary();
          v = d === 0 ? NaN : v / d;
        } else break;
      }
      return v;
    }

    function parseExpr() {
      let v = parseTerm();
      for (;;) {
        peek();
        if (match("+")) v += parseTerm();
        else if (match("-")) v -= parseTerm();
        else break;
      }
      return v;
    }

    const result = parseExpr();
    peek();
    if (i < src.length) throw new Error("trailing junk");
    return result;
  }

  function recomputeLive() {
    /** @type {Record<string, number|string>} */
    const values = {};
    /** @type {Record<string, string>} */
    const formulas = {};

    for (const [k, def] of Object.entries(schemaFields || {})) {
      if (def && def.formula) {
        formulas[k] = String(def.formula);
      } else {
        let v =
          actorFields[k] != null
            ? actorFields[k]
            : def && def.default != null
              ? def.default
              : 0;
        if (def && (def.type === "integer" || def.type === "number")) {
          const n = Number(v);
          values[k] = Number.isFinite(n) ? n : 0;
        } else if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
          values[k] = Number(v);
        } else {
          values[k] = v;
        }
      }
    }
    for (const [k, v] of Object.entries(actorFields || {})) {
      if (!(k in values) && !(k in formulas)) values[k] = v;
    }

    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (const [k, f] of Object.entries(formulas)) {
        try {
          const n = evalClosedFormula(f, /** @type {any} */ (values));
          if (Number.isFinite(n) && values[k] !== n) {
            values[k] = n;
            changed = true;
          } else if (!Number.isFinite(n)) {
            values[k] = 0;
          }
        } catch (_) {
          values[k] = 0;
        }
      }
      if (!changed) break;
    }
    liveValues = values;
    return values;
  }

  function isFormulaField(fid) {
    const def = schemaFields[fid];
    return !!(def && def.formula);
  }

  function showRollToast(msg) {
    if (!rollToastEl) return;
    rollToastEl.textContent = msg;
    rollToastEl.classList.add("show");
    clearTimeout(showRollToast._t);
    showRollToast._t = setTimeout(() => {
      rollToastEl.classList.remove("show");
    }, 2200);
  }

  function rollDie(sides) {
    const n = Math.max(2, Math.floor(Number(sides) || 20));
    return 1 + Math.floor(Math.random() * n);
  }

  /** localStorage shared across pywebview windows (sessionStorage is not). */
  function rollStore() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function appendRollToStorage(entry) {
    const store = rollStore();
    if (!store) return;
    let list = [];
    try {
      const raw = store.getItem(ROLL_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      list = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      list = [];
    }
    list.push(entry);
    try {
      store.setItem(ROLL_HISTORY_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  /**
   * Publish a layout-button roll to session history (storage + BroadcastChannel
   * + pywebview session_roll bridge). Keeps sheet toast separately.
   */
  function publishRoll(buttonLabel, result, detail) {
    const actorName =
      (titleEl && titleEl.textContent && titleEl.textContent.trim()) ||
      actorId ||
      "Actor";
    const label = `${actorName}: ${buttonLabel}`;
    const entry = {
      label,
      result,
      detail: detail || "",
      t: Date.now(),
    };
    appendRollToStorage(entry);
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const ch = new BroadcastChannel(ROLL_CHANNEL);
        ch.postMessage(entry);
        ch.close();
      }
    } catch (_) {}
    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.session_roll === "function"
        ? window.pywebview.api
        : null;
    if (api) {
      Promise.resolve(api.session_roll(label, result, detail || "", entry.t)).catch(() => {});
    }
  }

  function layoutBounds(list) {
    let maxX = 320;
    let maxY = 220;
    for (const w of list) {
      const r = (w.x || 0) + (w.w || 0) + 24;
      const b = (w.y || 0) + (w.h || 0) + 28;
      if (r > maxX) maxX = r;
      if (b > maxY) maxY = b;
    }
    return { w: Math.max(maxX, 320), h: Math.max(maxY, 220) };
  }

  function renderVisual() {
    recomputeLive();
    const list = widgets || [];
    if (!list.length) {
      svgEl.setAttribute("width", "100%");
      svgEl.setAttribute("height", "160");
      svgEl.removeAttribute("viewBox");
      svgEl.innerHTML =
        `<text x="16" y="40" fill="#9aa3b5" font-size="14">` +
        `No layout widgets — open Sheet builder, add boxes/circles/buttons, Compile.</text>`;
      return;
    }
    const bounds = layoutBounds(list);
    svgEl.setAttribute("width", String(bounds.w));
    svgEl.setAttribute("height", String(bounds.h));
    svgEl.setAttribute("viewBox", `0 0 ${bounds.w} ${bounds.h}`);

    let html = "";
    for (const w of list) {
      const cx = (w.x || 0) + (w.w || 0) / 2;
      const cy = (w.y || 0) + (w.h || 0) / 2;
      if (w.shape === "button") {
        const label = w.label || "Roll";
        const sides = (w.action && w.action.sides) || 20;
        html += `<g class="sheet-btn" data-sides="${esc(String(sides))}" data-label="${esc(label)}" style="cursor:pointer">`;
        html += `<rect class="widget-button" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="10" />`;
        html += `<text class="widget-btn-label" x="${cx}" y="${cy - 4}">${esc(label)}</text>`;
        html += `<text class="widget-btn-sub" x="${cx}" y="${cy + 12}">d${esc(String(sides))}</text>`;
        html += `</g>`;
      } else if (w.shape === "circle") {
        const r = Math.min(w.w || 0, w.h || 0) / 2;
        const fid = w.field || "";
        const val = fid ? liveValues[fid] : "";
        const formula = !!(fid && isFormulaField(fid));
        html += `<g>`;
        html += `<circle class="widget-circle" cx="${cx}" cy="${cy}" r="${r}" />`;
        if (fid && !formula) {
          const foW = Math.min(r * 1.8, 56);
          html += `<foreignObject x="${cx - foW / 2}" y="${cy - 12}" width="${foW}" height="24">`;
          html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit" type="number" data-field="${esc(fid)}" value="${esc(String(val))}" />`;
          html += `</foreignObject>`;
        } else {
          html += `<text class="widget-value${formula ? " formula" : ""}" x="${cx}" y="${cy}">${esc(String(val))}</text>`;
        }
        html += `<text class="widget-label" x="${cx}" y="${cy + r + 14}">${esc(fid || "(field)")}</text>`;
        html += `</g>`;
      } else {
        const fid = w.field || "";
        const val = fid ? liveValues[fid] : "";
        const formula = !!(fid && isFormulaField(fid));
        html += `<g>`;
        html += `<rect class="widget-box" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="6" />`;
        if (fid && !formula) {
          html += `<foreignObject x="${(w.x || 0) + 4}" y="${(w.y || 0) + (w.h || 0) / 2 - 12}" width="${Math.max(24, (w.w || 0) - 8)}" height="24">`;
          html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit" type="number" data-field="${esc(fid)}" value="${esc(String(val))}" />`;
          html += `</foreignObject>`;
        } else {
          html += `<text class="widget-value${formula ? " formula" : ""}" x="${cx}" y="${cy}">${esc(String(val))}</text>`;
        }
        html += `<text class="widget-label" x="${cx}" y="${(w.y || 0) + (w.h || 0) + 14}">${esc(fid || "(field)")}</text>`;
        html += `</g>`;
      }
    }
    svgEl.innerHTML = html;

    svgEl.querySelectorAll(".sheet-btn").forEach((g) => {
      g.addEventListener("click", () => {
        const sides = Number(g.getAttribute("data-sides")) || 20;
        const label = g.getAttribute("data-label") || "Roll";
        const result = rollDie(sides);
        showRollToast(`${label}: ${result} (d${sides})`);
        setStatus(`${label} → ${result}`);
        publishRoll(label, result, `d${sides}`);
      });
    });

    svgEl.querySelectorAll("input.field-edit").forEach((input) => {
      const commit = () => {
        const fid = input.getAttribute("data-field");
        if (!fid || isFormulaField(fid)) return;
        const n = Number(input.value);
        if (!Number.isFinite(n)) {
          setStatus("Invalid number");
          return;
        }
        actorFields[fid] = n;
        saveFields({ [fid]: n })
          .then(() => {
            renderVisual();
            setStatus(`Saved ${fid}=${n}`);
          })
          .catch((err) => setStatus(String(err)));
      };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
      });
    });
  }

  async function saveFields(partial) {
    const res = await fetch(`/api/actor/${encodeURIComponent(actorId)}/fields`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: partial }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Fields save failed (${res.status})`);
    }
    const data = await res.json();
    if (data.fields && typeof data.fields === "object") {
      actorFields = data.fields;
    }
    return data;
  }

  async function load() {
    if (!actorId) {
      titleEl.textContent = "No actor";
      setStatus("Missing ?actor= id");
      return;
    }
    const res = await fetch(`/api/sheet/${encodeURIComponent(actorId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      titleEl.textContent = actorId;
      setStatus(err.error || `Load failed (${res.status})`);
      return;
    }
    const data = await res.json();
    document.title = `${data.name || actorId} · Sheet`;
    titleEl.textContent = data.name || actorId;
    pathEl.textContent =
      (data.sheet_id ? `sheet: ${data.sheet_id} · ` : "") + (data.path || "");
    textEl.value = data.text || "";
    appearance =
      data.appearance && typeof data.appearance === "object"
        ? data.appearance
        : { size_tiles: 1 };
    let size = Number(appearance.size_tiles);
    if (!(size > 0)) size = 1;
    appearance.size_tiles = size;
    sizeTilesEl.value = String(size);

    schemaFields =
      data.schema && data.schema.fields && typeof data.schema.fields === "object"
        ? data.schema.fields
        : {};
    actorFields = data.fields && typeof data.fields === "object" ? data.fields : {};
    widgets =
      data.layout && Array.isArray(data.layout.widgets) ? data.layout.widgets : [];

    renderVisual();
    if (!widgets.length && (data.text || "").trim()) {
      notesBlock.open = true;
    }
    setStatus("Ready");
    setAppearanceStatus("");
  }

  async function save() {
    if (!actorId) return;
    setStatus("Saving…");
    const res = await fetch(`/api/sheet/${encodeURIComponent(actorId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: textEl.value }),
    });
    if (!res.ok) {
      setStatus(`Failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setStatus(`Saved notes · ${data.path}`);
  }

  async function saveAppearance() {
    if (!actorId) return;
    let size = Number(sizeTilesEl.value);
    if (!(size > 0)) {
      setAppearanceStatus("Tiles across must be > 0");
      return;
    }
    setAppearanceStatus("Saving…");
    const body = { appearance: { size_tiles: size } };
    const res = await fetch(
      `/api/actor/${encodeURIComponent(actorId)}/appearance`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setAppearanceStatus(err.error || `Failed (${res.status})`);
      return;
    }
    const data = await res.json();
    appearance = data.appearance || body.appearance;
    sizeTilesEl.value = String(appearance.size_tiles ?? size);
    setAppearanceStatus("Appearance saved · map tokens updated");
    notifyMap(actorId, appearance);
  }

  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab || "sheet"));
  }

  document.getElementById("save").addEventListener("click", () => {
    save().catch((err) => setStatus(String(err)));
  });
  document.getElementById("save-appearance").addEventListener("click", () => {
    saveAppearance().catch((err) => setAppearanceStatus(String(err)));
  });

  load().catch((err) => setStatus(String(err)));
})();
