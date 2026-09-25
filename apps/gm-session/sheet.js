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
  const panelMechanics = document.getElementById("panel-mechanics");
  const panelAppearance = document.getElementById("panel-appearance");
  const mechanicsListEl = document.getElementById("mechanics-list");
  const mechanicsStatusEl = document.getElementById("mechanics-status");
  const btnMechImport = document.getElementById("btn-mech-import");
  const mechImportPanel = document.getElementById("mech-import-panel");
  const mechImportSelect = document.getElementById("mech-import-select");
  const btnMechImportConfirm = document.getElementById("btn-mech-import-confirm");
  const btnMechImportCancel = document.getElementById("btn-mech-import-cancel");
  const mechImportHint = document.getElementById("mech-import-hint");
  const svgEl = document.getElementById("sheet-svg");
  const rollToastEl = document.getElementById("roll-toast");
  const notesBlock = document.getElementById("notes-block");
  const visualWrap = document.getElementById("sheet-visual-wrap");

  const RT = window.SheetRuntime || null;
  const IX = window.ImageXform;
  const TA = window.TokenAuras;

  /** @type {any} */
  let appearance = { size_tiles: 1 };
  /** @type {Record<string, any>} */
  let schemaFields = {};
  /** @type {Record<string, any>} */
  let actorFields = {};
  /** @type {object[]} */
  let widgets = [];
  /** @type {{ nodes: object[], edges: object[], collapsed?: object[] }} */
  let graph = { nodes: [], edges: [], collapsed: [] };
  /** @type {string|null} schema id from GET /api/sheet */
  let sheetId = null;
  /** @type {Record<string, number|string>} */
  let liveValues = {};
  /** Dual-value widget currently showing base editor (widget id), or null */
  let editingDualWidgetId = null;

  /** Session sheet view (after fit): pan/zoom in viewBox space */
  let sheetView = { scale: 1, x: 0, y: 0, base: null };
  let sheetPan = null;
  let spaceDown = false;

  const APPEARANCE_CHANNEL = "gm-session-appearance";
  const ROLL_CHANNEL = "gm-session-roll";
  const ROLL_HISTORY_KEY = "gm-session-roll-history";

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setAppearanceStatus(msg) {
    appearanceStatusEl.textContent = msg || "";
  }

  function setMechanicsStatus(msg) {
    if (mechanicsStatusEl) mechanicsStatusEl.textContent = msg || "";
  }

  function switchTab(name) {
    const tab = name === "mechanics" || name === "appearance" ? name : "sheet";
    panelSheet.classList.toggle("active", tab === "sheet");
    if (panelMechanics) panelMechanics.classList.toggle("active", tab === "mechanics");
    panelAppearance.classList.toggle("active", tab === "appearance");
    for (const btn of document.querySelectorAll(".tabs button")) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (tab === "sheet") {
      requestAnimationFrame(() => fitToView());
    }
    if (tab === "mechanics") {
      renderMechanics();
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

  function evalClosedFormula(expr, env) {
    if (RT && typeof RT.evalClosedFormula === "function") {
      return RT.evalClosedFormula(expr, env);
    }
    throw new Error("SheetRuntime missing");
  }

  function rollDie(sides) {
    if (RT && typeof RT.rollDie === "function") return RT.rollDie(sides);
    const n = Math.max(2, Math.floor(Number(sides) || 20));
    return 1 + Math.floor(Math.random() * n);
  }

  function seedFieldValue(k, def, raw) {
    let v = raw;
    if (v === undefined || v === null) {
      v =
        actorFields[k] != null
          ? actorFields[k]
          : def && def.default != null
            ? def.default
            : 0;
    }
    if (def && (def.type === "integer" || def.type === "number")) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
    return v;
  }

  function collectEditableBases() {
    /** @type {Set<string>} */
    const bases = new Set();
    for (const w of widgets || []) {
      const inn = widgetInputId(w);
      const out = widgetOutputId(w);
      if (inn && out && inn !== out) bases.add(inn);
    }
    return bases;
  }

  function recomputeLive() {
    /** @type {Record<string, number|string>} */
    const values = {};
    /** @type {Record<string, string>} */
    const formulas = {};
    const editableBases = collectEditableBases();

    for (const [k, def] of Object.entries(schemaFields || {})) {
      // Editable dual-widget bases must never be formula-driven (edits ignored + 0).
      if (def && def.formula && !editableBases.has(k)) {
        formulas[k] = String(def.formula);
      } else {
        values[k] = seedFieldValue(k, def);
      }
    }
    for (const [k, v] of Object.entries(actorFields || {})) {
      if (!(k in values) && !(k in formulas)) values[k] = v;
    }

    // Built-in aura radius fields (AURA1..3_RADIUS) read as 0 until set
    if (TA) {
      for (const k of TA.AURA_FIELDS) {
        if (!(k in values) && !(k in formulas)) values[k] = 0;
      }
    }

    // Ensure editable bases are seeded even if absent from schema
    for (const k of editableBases) {
      if (k in formulas) delete formulas[k];
      if (!(k in values)) {
        values[k] = seedFieldValue(k, schemaFields[k]);
      }
    }

    // Live-compile graph macros when schema formulas are missing/stale.
    // Prefer compiled formulas as source of truth when compile succeeds.
    if (RT && typeof RT.compileGraph === "function" && graph) {
      const fieldKeys = new Set();
      for (const k of Object.keys(schemaFields || {})) fieldKeys.add(k);
      for (const k of Object.keys(actorFields || {})) fieldKeys.add(k);
      if (TA) for (const k of TA.AURA_FIELDS) fieldKeys.add(k);
      for (const w of widgets || []) {
        const inn = widgetInputId(w);
        const out = widgetOutputId(w);
        if (inn) fieldKeys.add(inn);
        if (out) fieldKeys.add(out);
      }
      const compiled = RT.compileGraph(graph, [...fieldKeys]);
      if (compiled && !compiled.error && compiled.formulas) {
        for (const [k, f] of Object.entries(compiled.formulas)) {
          if (!f || editableBases.has(k)) continue;
          formulas[k] = String(f);
          if (k in values) delete values[k];
        }
      }
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
    publishAuraFields(values);
    return values;
  }

  /** Push AURA*_RADIUS to the map whenever they change (edit, automation, formula). */
  let lastAuraJson = "";
  function publishAuraFields(values) {
    if (!TA || !actorId) return;
    const aura = TA.pickAuraFields(values);
    const json = JSON.stringify(aura);
    if (json === lastAuraJson) return;
    lastAuraJson = json;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const ch = new BroadcastChannel(APPEARANCE_CHANNEL);
        ch.postMessage({ actor_id: actorId, aura_fields: aura });
        ch.close();
      }
    } catch (_) {}
    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.aura_fields_changed === "function"
        ? window.pywebview.api
        : null;
    if (api) Promise.resolve(api.aura_fields_changed(actorId, aura)).catch(() => {});
    if (typeof renderAuraRadii === "function") renderAuraRadii();
  }

  function isFormulaField(fid) {
    const def = schemaFields[fid];
    return !!(def && def.formula);
  }

  function widgetCaption(w) {
    if (RT && typeof RT.widgetCaption === "function") return RT.widgetCaption(w);
    const lab = String((w && w.label) || "").trim();
    if (lab) return lab;
    return widgetInputId(w);
  }

  function widgetInputId(w) {
    if (RT && typeof RT.widgetInputId === "function") return RT.widgetInputId(w);
    return String((w && (w.input_id || w.field)) || "").trim();
  }

  function widgetOutputId(w) {
    if (RT && typeof RT.widgetOutputId === "function") return RT.widgetOutputId(w);
    return String((w && (w.output_id || w.input_id || w.field)) || "").trim();
  }

  function widgetKey(w) {
    if (RT && typeof RT.widgetUid === "function") return RT.widgetUid(w);
    if (!w) return "";
    if (w.shape === "box" || w.shape === "circle") return String(w.uid || w.id || "");
    return String(w.id || "");
  }

  function widgetHasOutput(w) {
    if (RT && typeof RT.widgetHasOutputValue === "function") {
      return RT.widgetHasOutputValue(w, {
        liveValues,
        schemaFields,
        graph,
      });
    }
    const inKey = widgetInputId(w);
    const outKey = widgetOutputId(w);
    return !!(outKey && outKey !== inKey && isFormulaField(outKey));
  }

  function resolveWidgetValue(w) {
    if (RT && typeof RT.resolveWidgetValue === "function") {
      return RT.resolveWidgetValue(w, {
        liveValues,
        schemaFields,
        graph,
      });
    }
    const key = widgetInputId(w);
    return key && liveValues[key] != null ? liveValues[key] : 0;
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

  function contentBounds(list) {
    if (!list.length) return { minX: 0, minY: 0, maxX: 320, maxY: 220 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of list) {
      const x0 = w.x || 0;
      const y0 = w.y || 0;
      const x1 = x0 + (w.w || 0);
      const y1 = y0 + (w.h || 0) + 18;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, maxX: 320, maxY: 220 };
    }
    return { minX, minY, maxX, maxY };
  }

  function applyViewBox() {
    const base = sheetView.base;
    if (!base) return;
    const { minX, minY, w, h } = base;
    const s = sheetView.scale;
    const vw = w / s;
    const vh = h / s;
    const vx = minX + sheetView.x;
    const vy = minY + sheetView.y;
    svgEl.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
  }

  function fitToView() {
    const list = widgets || [];
    if (!list.length) {
      sheetView.base = null;
      svgEl.removeAttribute("viewBox");
      return;
    }
    const b = contentBounds(list);
    const pad = 20;
    const minX = b.minX - pad;
    const minY = b.minY - pad;
    const w = Math.max(40, b.maxX - b.minX + pad * 2);
    const h = Math.max(40, b.maxY - b.minY + pad * 2);
    sheetView = { scale: 1, x: 0, y: 0, base: { minX, minY, w, h } };
    applyViewBox();
  }

  function svgPoint(svg, evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function normalizeButton(w) {
    const mode = w.mode === "toggle" ? "toggle" : "trigger";
    let functionId = w.function_id != null ? String(w.function_id) : "";
    if (!functionId && w.action && w.action.type === "roll") {
      // Legacy frontend roll — no automation; leave empty
      functionId = "";
    }
    return { mode, functionId, label: w.label || "Button" };
  }

  function buttonSubtitle(w) {
    const { mode, functionId } = normalizeButton(w);
    if (functionId) return `${mode} · ${functionId}`;
    return mode;
  }


  /** Field value is "on" when nonzero finite (missing/nonfinite → off). */
  function fieldToggleOn(name) {
    const key = name != null ? String(name).trim() : "";
    if (!key) return false;
    const v = liveValues[key] != null ? liveValues[key] : actorFields[key];
    const n = Number(v);
    return Number.isFinite(n) && n !== 0;
  }

  /**
   * Toggle mode: flip actor field named by function_id / mechanic name between 0 and 1.
   * Does not invoke evaluateNamedFunction (unlike trigger).
   * @param {string} fieldName
   * @param {{ label?: string, statusFn?: (s:string)=>void }} [runOpts]
   */
  async function runToggleField(fieldName, runOpts) {
    const optsIn = runOpts && typeof runOpts === "object" ? runOpts : {};
    const statusFn = typeof optsIn.statusFn === "function" ? optsIn.statusFn : setStatus;
    const label = optsIn.label || fieldName || "Toggle";
    const name = fieldName != null ? String(fieldName).trim() : "";
    if (!name) {
      statusFn("Toggle needs a function id (used as field name)");
      return;
    }
    recomputeLive();
    const cur = liveValues[name] != null ? liveValues[name] : actorFields[name];
    const curN = Number(cur);
    const on = Number.isFinite(curN) && curN !== 0;
    const next = on ? 0 : 1;
    actorFields[name] = next;
    liveValues[name] = next;
    try {
      await saveFields({ [name]: next });
    } catch (err) {
      statusFn(String(err));
      return;
    }
    recomputeLive();
    statusFn(`${label} [toggle] → ${name}=${next}`);
    renderVisual(false);
    if (panelMechanics && panelMechanics.classList.contains("active")) {
      renderMechanics();
    }
  }

  /**
   * Shared runner for layout buttons and Mechanics tab.
   * @param {string} functionId
   * @param {{ mode?: string, label?: string, entryValue?: number, statusFn?: (s:string)=>void }} [runOpts]
   */
  async function runNamedFunction(functionId, runOpts) {
    const optsIn = runOpts && typeof runOpts === "object" ? runOpts : {};
    const mode = optsIn.mode === "toggle" ? "toggle" : "trigger";
    const label = optsIn.label || functionId || "Function";
    const statusFn = typeof optsIn.statusFn === "function" ? optsIn.statusFn : setStatus;
    const fid = functionId != null ? String(functionId) : "";
    if (!fid) {
      statusFn("No function id");
      return;
    }
    if (!RT || typeof RT.evaluateNamedFunction !== "function") {
      statusFn("SheetRuntime missing");
      return;
    }
    recomputeLive();
    const evalOpts = {};
    if (optsIn.entryValue !== undefined) evalOpts.entryValue = optsIn.entryValue;
    const result = RT.evaluateNamedFunction(
      graph,
      fid,
      liveValues,
      Object.keys(evalOpts).length ? evalOpts : undefined
    );
    if (!result.ok) {
      statusFn(result.error || "Function failed");
      return;
    }
    // Local toast for rolls (optional feedback); chat/history only via send_to_chat
    const messages = result.messages || [];
    if (!messages.length) {
      for (const r of result.rolls || []) {
        const detail = `d${r.sides}`;
        const rollLabel = `${label} / ${fid}`;
        showRollToast(`${rollLabel}: ${r.result} (${detail})`);
      }
    }
    for (const m of messages) {
      const chatLabel = m.text
        ? `${label} / ${fid} · ${m.text}`
        : `${label} / ${fid}`;
      const detail = m.detail || "";
      showRollToast(`${chatLabel}: ${m.value}${detail ? ` (${detail})` : ""}`);
      publishRoll(chatLabel, m.value, detail);
    }
    const writes = result.writes || {};
    const keys = Object.keys(writes);
    if (keys.length) {
      for (const k of keys) {
        actorFields[k] = writes[k];
        liveValues[k] = writes[k];
      }
      try {
        await saveFields(writes);
      } catch (err) {
        statusFn(String(err));
        return;
      }
    }
    const msgSummary =
      messages.map((m) => String(m.value)).join(", ") ||
      (result.rolls || []).map((r) => `${r.result}(d${r.sides})`).join(", ") ||
      "ok";
    statusFn(`${label} [${mode}] → ${fid}: ${msgSummary}`);
    renderVisual(false);
    if (panelMechanics && panelMechanics.classList.contains("active")) {
      renderMechanics();
    }
  }

  async function runButtonFunction(w, runOpts) {
    const { mode, functionId, label } = normalizeButton(w);
    if (!functionId) {
      setStatus("Button has no function id");
      return;
    }
    const opts = runOpts && typeof runOpts === "object" ? { ...runOpts } : {};
    opts.mode = mode;
    opts.label = label;
    await runNamedFunction(functionId, opts);
  }

  function namedFunctionsOnSheet() {
    const nodes = (graph && graph.nodes) || [];
    const names = [];
    const seen = new Set();
    for (const n of nodes) {
      if (!n) continue;
      if (n.kind !== "entry" && n.kind !== "function") continue;
      const name = n.name != null ? String(n.name).trim() : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b));
    return names;
  }

  function closeMechImport() {
    if (!mechImportPanel) return;
    mechImportPanel.hidden = true;
    mechImportPanel.classList.remove("open");
  }

  function openMechImport() {
    if (!mechImportPanel) return;
    mechImportPanel.hidden = false;
    mechImportPanel.classList.add("open");
  }

  async function showMechImportChooser() {
    if (!sheetId) {
      setMechanicsStatus("No sheet_id on this actor — cannot import");
      return;
    }
    openMechImport();
    setMechanicsStatus("Loading mechanics library…");
    try {
      const res = await fetch("/api/mechanics");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMechanicsStatus(data.error || `Library load failed (${res.status})`);
        return;
      }
      const present = new Set(namedFunctionsOnSheet());
      const all = Array.isArray(data.mechanics) ? data.mechanics : [];
      const available = all.filter((m) => m && m.name && !present.has(String(m.name)));
      if (!mechImportSelect) return;
      mechImportSelect.innerHTML = "";
      if (mechImportHint) {
        if (!all.length) {
          mechImportHint.hidden = false;
          mechImportHint.textContent =
            "Library empty — publish a Function from Sheet builder (Publish to library).";
        } else if (!available.length) {
          mechImportHint.hidden = false;
          mechImportHint.textContent =
            "All library mechanics are already on this sheet.";
        } else {
          mechImportHint.hidden = true;
          mechImportHint.textContent = "";
        }
      }
      for (const m of available) {
        const opt = document.createElement("option");
        opt.value = String(m.name);
        opt.textContent = String(m.name);
        mechImportSelect.appendChild(opt);
      }
      if (btnMechImportConfirm) btnMechImportConfirm.disabled = !available.length;
      setMechanicsStatus(
        available.length
          ? `Choose a mechanic (${available.length} available)`
          : all.length
            ? "Nothing new to import"
            : "Library empty"
      );
    } catch (err) {
      setMechanicsStatus(String(err));
    }
  }

  async function confirmMechImport() {
    if (!sheetId) {
      setMechanicsStatus("Missing sheet_id");
      return;
    }
    const name = mechImportSelect && mechImportSelect.value;
    if (!name) {
      setMechanicsStatus("Select a mechanic first");
      return;
    }
    setMechanicsStatus(`Importing "${name}"…`);
    try {
      const res = await fetch(
        `/api/sheet-builder/${encodeURIComponent(sheetId)}/import-mechanic`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMechanicsStatus(data.error || `Import failed (${res.status})`);
        return;
      }
      closeMechImport();
      await load();
      setMechanicsStatus(
        `Imported mechanic "${name}" (${data.graph_node_count ?? "?"} graph nodes)`
      );
    } catch (err) {
      setMechanicsStatus(String(err));
    }
  }

  function renderMechanics() {
    if (!mechanicsListEl) return;
    recomputeLive();
    const names = namedFunctionsOnSheet();
    if (!names.length) {
      mechanicsListEl.innerHTML =
        `<p class="mech-empty">No named functions on this sheet — add Function entries in Sheet builder, or Import… from the campaign library.</p>` +
        `<p class="mech-empty">Toggle uses the row name as a field id (flips 0/1); Trigger still runs the named automation.</p>`;
      return;
    }
    let html =
      `<p class="mech-empty" style="margin-bottom:0.5rem">Trigger runs the named function. Toggle flips field <em>name</em> between 0 and 1 (does not invoke the graph). Templates with <code>[x]</code> need a button id (e.g. check_ATK) — Trigger on the template name alone will error.</p>`;
    for (const name of names) {
      const isTemplate = name.includes("[x]");
      const pressed = fieldToggleOn(name);
      html += `<div class="mech-row" data-fn="${esc(name)}">`;
      html += `<span class="mech-name">${esc(name)}${isTemplate ? ' <span class="mech-empty">(template)</span>' : ""}</span>`;
      html += `<button type="button" class="mech-trigger" data-action="trigger" title="${isTemplate ? "Needs button function_id with concrete ID" : "Run named function"}">Trigger</button>`;
      html += `<button type="button" class="mech-toggle${pressed ? " toggle-on" : ""}" data-action="toggle" aria-pressed="${pressed ? "true" : "false"}">${pressed ? "On" : "Off"}</button>`;
      html += `</div>`;
    }
    mechanicsListEl.innerHTML = html;
    mechanicsListEl.querySelectorAll(".mech-row").forEach((row) => {
      const name = row.getAttribute("data-fn") || "";
      row.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = btn.getAttribute("data-action");
          if (action === "toggle") {
            runToggleField(name, {
              label: name,
              statusFn: setMechanicsStatus,
            }).catch((err) => setMechanicsStatus(String(err)));
          } else {
            runNamedFunction(name, {
              mode: "trigger",
              label: name,
              statusFn: setMechanicsStatus,
            }).catch((err) => setMechanicsStatus(String(err)));
          }
        });
      });
    });
  }

  function renderVisual(doFit) {
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

    let html = `<g id="sheet-world">`;
    for (const w of list) {
      const cx = (w.x || 0) + (w.w || 0) / 2;
      const cy = (w.y || 0) + (w.h || 0) / 2;
      if (w.shape === "button") {
        const { mode, functionId, label } = normalizeButton(w);
        const pressed = mode === "toggle" && !!functionId && fieldToggleOn(functionId);
        const sub = buttonSubtitle(w);
        html += `<g class="sheet-btn${pressed ? " pressed" : ""}" data-id="${esc(w.id)}" data-mode="${esc(mode)}" data-function="${esc(functionId)}" style="cursor:pointer">`;
        html += `<rect class="widget-button${pressed ? " toggle-on" : ""}" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="10" />`;
        html += `<text class="widget-btn-label" x="${cx}" y="${cy - 4}">${esc(label)}</text>`;
        html += `<text class="widget-btn-sub" x="${cx}" y="${cy + 12}">${esc(sub)}</text>`;
        html += `</g>`;
      } else if (w.shape === "circle") {
        const r = Math.min(w.w || 0, w.h || 0) / 2;
        const inKey = widgetInputId(w);
        const caption = widgetCaption(w) || inKey || "(label)";
        const hasOut = widgetHasOutput(w);
        const displayVal = resolveWidgetValue(w);
        const baseVal =
          inKey && liveValues[inKey] != null
            ? liveValues[inKey]
            : inKey && schemaFields[inKey] && schemaFields[inKey].default != null
              ? schemaFields[inKey].default
              : 0;
        html += `<g>`;
        html += `<circle class="widget-circle" cx="${cx}" cy="${cy}" r="${r}" />`;
        const outKey = widgetOutputId(w);
        if (hasOut && inKey && outKey && outKey !== inKey) {
          // Output-only until edit; click reveals base input (never paint display into base)
          const editing = editingDualWidgetId === widgetKey(w);
          if (editing) {
            const foW = Math.min(r * 1.8, 64);
            html += `<foreignObject x="${cx - foW / 2}" y="${cy - 12}" width="${foW}" height="24">`;
            html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit field-edit-dual" type="number" data-field="${esc(inKey)}" data-dual-widget="${esc(widgetKey(w))}" value="${esc(String(baseVal))}" title="Base (${esc(inKey)})" />`;
            html += `</foreignObject>`;
          } else {
            html += `<text class="widget-value formula dual-display" data-dual-widget="${esc(widgetKey(w))}" x="${cx}" y="${cy}" style="cursor:pointer">${esc(String(displayVal))}</text>`;
          }
        } else if (hasOut) {
          html += `<text class="widget-value formula" x="${cx}" y="${cy}">${esc(String(displayVal))}</text>`;
        } else if (inKey) {
          const foW = Math.min(r * 1.8, 56);
          html += `<foreignObject x="${cx - foW / 2}" y="${cy - 12}" width="${foW}" height="24">`;
          html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit" type="number" data-field="${esc(inKey)}" value="${esc(String(baseVal))}" />`;
          html += `</foreignObject>`;
        } else {
          html += `<text class="widget-value" x="${cx}" y="${cy}">${esc(String(displayVal))}</text>`;
        }
        html += `<text class="widget-label" x="${cx}" y="${cy + r + 14}">${esc(caption)}</text>`;
        html += `</g>`;
      } else {
        const inKey = widgetInputId(w);
        const caption = widgetCaption(w) || inKey || "(label)";
        const hasOut = widgetHasOutput(w);
        const displayVal = resolveWidgetValue(w);
        const baseVal =
          inKey && liveValues[inKey] != null
            ? liveValues[inKey]
            : inKey && schemaFields[inKey] && schemaFields[inKey].default != null
              ? schemaFields[inKey].default
              : 0;
        html += `<g>`;
        html += `<rect class="widget-box" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="6" />`;
        const outKey = widgetOutputId(w);
        if (hasOut && inKey && outKey && outKey !== inKey) {
          const editing = editingDualWidgetId === widgetKey(w);
          if (editing) {
            html += `<foreignObject x="${(w.x || 0) + 4}" y="${(w.y || 0) + (w.h || 0) / 2 - 12}" width="${Math.max(24, (w.w || 0) - 8)}" height="24">`;
            html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit field-edit-dual" type="number" data-field="${esc(inKey)}" data-dual-widget="${esc(widgetKey(w))}" value="${esc(String(baseVal))}" title="Base (${esc(inKey)})" />`;
            html += `</foreignObject>`;
          } else {
            html += `<text class="widget-value formula dual-display" data-dual-widget="${esc(widgetKey(w))}" x="${cx}" y="${cy}" style="cursor:pointer">${esc(String(displayVal))}</text>`;
          }
        } else if (hasOut) {
          html += `<text class="widget-value formula" x="${cx}" y="${cy}">${esc(String(displayVal))}</text>`;
        } else if (inKey) {
          html += `<foreignObject x="${(w.x || 0) + 4}" y="${(w.y || 0) + (w.h || 0) / 2 - 12}" width="${Math.max(24, (w.w || 0) - 8)}" height="24">`;
          html += `<input xmlns="http://www.w3.org/1999/xhtml" class="field-edit" type="number" data-field="${esc(inKey)}" value="${esc(String(baseVal))}" />`;
          html += `</foreignObject>`;
        } else {
          html += `<text class="widget-value" x="${cx}" y="${cy}">${esc(String(displayVal))}</text>`;
        }
        html += `<text class="widget-label" x="${cx}" y="${(w.y || 0) + (w.h || 0) + 14}">${esc(caption)}</text>`;
        html += `</g>`;
      }
    }
    html += `</g>`;
    svgEl.innerHTML = html;

    if (doFit !== false || !sheetView.base) fitToView();
    else applyViewBox();

    svgEl.querySelectorAll(".sheet-btn").forEach((g) => {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = g.getAttribute("data-id");
        const w = (widgets || []).find((x) => x.id === id);
        if (!w) return;
        const { mode, functionId, label } = normalizeButton(w);
        if (mode === "toggle") {
          // Flip field named by function_id (0/1); do not run evaluateNamedFunction
          runToggleField(functionId, { label }).catch((err) => setStatus(String(err)));
        } else {
          runButtonFunction(w).catch((err) => setStatus(String(err)));
        }
      });
    });

    svgEl.querySelectorAll("text.dual-display").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const wid = el.getAttribute("data-dual-widget");
        if (!wid) return;
        editingDualWidgetId = wid;
        renderVisual(false);
      });
    });

    svgEl.querySelectorAll("input.field-edit").forEach((input) => {
      const isDual = input.classList.contains("field-edit-dual");
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const fid = input.getAttribute("data-field");
        if (!fid || isFormulaField(fid)) {
          if (isDual) {
            editingDualWidgetId = null;
            renderVisual(false);
          }
          return;
        }
        const n = Number(input.value);
        if (!Number.isFinite(n)) {
          committed = false;
          setStatus("Invalid number");
          return;
        }
        actorFields[fid] = n;
        const finish = () => {
          if (isDual) editingDualWidgetId = null;
          renderVisual(false);
          setStatus(`Saved ${fid}=${n}`);
        };
        saveFields({ [fid]: n })
          .then(finish)
          .catch((err) => {
            if (isDual) editingDualWidgetId = null;
            setStatus(String(err));
            renderVisual(false);
          });
      };
      if (isDual) {
        input.addEventListener("blur", commit);
      } else {
        input.addEventListener("change", commit);
      }
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
          if (!isDual) commit();
        } else if (e.key === "Escape" && isDual) {
          e.preventDefault();
          committed = true;
          editingDualWidgetId = null;
          renderVisual(false);
        }
      });
      if (isDual) {
        requestAnimationFrame(() => {
          try {
            input.focus();
            input.select();
          } catch (_) {}
        });
      }
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

  // 0.6.19: actor renamed from the map sidebar → retitle this sheet (id unchanged)
  function applyActorRename(id, name) {
    if (!actorId || id !== actorId || !name) return;
    titleEl.textContent = name;
    document.title = `${name} · Sheet`;
    actorName = name;
    if (actorNameEl && document.activeElement !== actorNameEl) actorNameEl.value = name;
  }
  window.__gmActorRenamed = applyActorRename;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const rc = new BroadcastChannel("gm-session-rename");
      rc.onmessage = (ev) => {
        const d = ev && ev.data;
        if (d && d.kind === "actor") applyActorRename(d.id, d.name);
      };
    } catch (_) {
      /* ignore */
    }
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
    actorName = data.name || actorId;
    if (actorNameEl) actorNameEl.value = actorName;
    sheetId =
      data.sheet_id != null && String(data.sheet_id).trim()
        ? String(data.sheet_id).trim()
        : null;
    pathEl.textContent =
      (sheetId ? `sheet: ${sheetId} · ` : "") + (data.path || "");
    textEl.value = data.text || "";
    appearance =
      data.appearance && typeof data.appearance === "object"
        ? data.appearance
        : { size_tiles: 1 };
    let size = Number(appearance.size_tiles);
    if (!(size > 0)) size = 1;
    appearance.size_tiles = size;
    sizeTilesEl.value = String(size);
    appearance.auras = TA ? TA.normalizeAuras(appearance.auras) : [];

    schemaFields =
      data.schema && data.schema.fields && typeof data.schema.fields === "object"
        ? data.schema.fields
        : {};
    actorFields = data.fields && typeof data.fields === "object" ? data.fields : {};
    widgets =
      data.layout && Array.isArray(data.layout.widgets) ? data.layout.widgets : [];
    graph =
      data.graph && typeof data.graph === "object"
        ? {
            nodes: Array.isArray(data.graph.nodes) ? data.graph.nodes : [],
            edges: Array.isArray(data.graph.edges) ? data.graph.edges : [],
            collapsed: Array.isArray(data.graph.collapsed) ? data.graph.collapsed : [],
          }
        : { nodes: [], edges: [], collapsed: [] };

    // Migrate legacy box/circle → label/input_id/output_id
    if (RT && typeof RT.migrateDisplayWidget === "function") {
      widgets = widgets.map((w) =>
        w && (w.shape === "box" || w.shape === "circle")
          ? RT.migrateDisplayWidget(w, schemaFields)
          : w
      );
    }

    renderVisual(true);
    renderMechanics();
    renderGraphic();
    renderAuras();
    if (!widgets.length && (data.text || "").trim()) {
      notesBlock.open = true;
    }
    setStatus("Ready");
    setAppearanceStatus("");
    setMechanicsStatus("");
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

  // --- 0.6.20 character name (Appearance → Name) ---
  // Same propagation as the old sidebar rename: server updates actor name,
  // fields.name (if it matched) and derived token names/labels on every scene;
  // the map and this window's title follow.
  let actorName = "";
  const actorNameEl = document.getElementById("actor-name");
  const btnActorRename = document.getElementById("btn-actor-rename");
  async function renameActor() {
    if (!actorId || !actorNameEl) return;
    const next = actorNameEl.value.trim();
    if (!next) {
      actorNameEl.value = actorName;
      setAppearanceStatus("Name cannot be empty");
      return;
    }
    if (next === actorName) return;
    setAppearanceStatus("Renaming…");
    const res = await fetch("/api/organization/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "actor", panel: "actors", id: actorId, name: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAppearanceStatus(data.error || `Rename failed (${res.status})`);
      actorNameEl.value = actorName;
      return;
    }
    const old = actorName;
    actorName = data.name || next;
    actorNameEl.value = actorName;
    if (actorFields && (actorFields.name === old || actorFields.name == null || actorFields.name === "")) {
      actorFields.name = actorName;
      renderVisual(false);
    }
    applyActorRename(actorId, actorName);
    const api = window.pywebview && window.pywebview.api;
    if (api && typeof api.actor_renamed === "function") {
      Promise.resolve(api.actor_renamed(actorId, actorName)).catch(() => {});
    } else if (typeof BroadcastChannel !== "undefined") {
      try {
        const ch = new BroadcastChannel("gm-session-rename");
        ch.postMessage({ kind: "actor", id: actorId, name: actorName });
        ch.close();
      } catch (_) {}
    }
    setAppearanceStatus(
      `Renamed “${old}” → “${actorName}”` +
        (data.tokens_updated ? ` · ${data.tokens_updated} token label(s) updated` : "")
    );
  }
  if (actorNameEl) {
    actorNameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        renameActor();
      } else if (e.key === "Escape") {
        actorNameEl.value = actorName;
      }
    });
    actorNameEl.addEventListener("change", () => renameActor());
  }
  if (btnActorRename) btnActorRename.addEventListener("click", () => renameActor());

  // --- Token graphic + auras (Appearance tab; per actor) ---

  /** PUT a partial appearance ({image}, {auras}, …); null removes a key. */
  async function persistAppearance(partial) {
    if (!actorId) return null;
    const res = await fetch(`/api/actor/${encodeURIComponent(actorId)}/appearance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: partial }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Appearance save failed (${res.status})`);
    }
    const data = await res.json();
    appearance = data.appearance || appearance;
    appearance.auras = TA.normalizeAuras(appearance.auras);
    // Include null image explicitly so the map drops a removed image.
    notifyMap(actorId, { ...appearance, image: appearance.image || null });
    return appearance;
  }

  const tokenImgCache = new Map();
  function loadAssetImage(hash) {
    if (tokenImgCache.has(hash)) return Promise.resolve(tokenImgCache.get(hash));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        tokenImgCache.set(hash, img);
        resolve(img);
      };
      img.onerror = () => reject(new Error("Could not load token image"));
      img.src = `/assets/${hash}`;
    });
  }

  function tokenSizeTiles() {
    const n = Number(appearance && appearance.size_tiles);
    return n > 0 ? n : 1;
  }

  /** Draw the token (image clipped to frame, or white circle) into a square frame. */
  function paintToken(ctx, img, crop, fx, fy, side) {
    const r = side / 2;
    const cx = fx + r;
    const cy = fy + r;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    if (img && crop) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      const rect = IX.cropScreenRect(crop, fx, fy, side);
      IX.drawTransformed(ctx, img, rect.x, rect.y, rect.w, rect.h, crop.rotation, crop.flipX, crop.flipY);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(20, 24, 36, 0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const previewEl = document.getElementById("token-preview");
  const btnTokenImport = document.getElementById("btn-token-import");
  const btnTokenEdit = document.getElementById("btn-token-edit-crop");
  const btnTokenRemove = document.getElementById("btn-token-remove-image");
  const tokenFileEl = document.getElementById("token-image-file");
  const tokenInfoEl = document.getElementById("token-image-info");

  function renderGraphic() {
    const imgDef = appearance && appearance.image;
    const crop = imgDef && IX.normalizeCrop(imgDef.crop);
    if (btnTokenEdit) btnTokenEdit.disabled = !crop;
    if (btnTokenRemove) btnTokenRemove.disabled = !crop;
    if (tokenInfoEl) {
      tokenInfoEl.textContent = crop
        ? `Image: ${imgDef.name || imgDef.asset.slice(0, 12) + "…"} · stored in campaign assets · applies to all tokens of this actor`
        : "No image — white circle token.";
    }
    if (!previewEl) return;
    const ctx = previewEl.getContext("2d");
    ctx.clearRect(0, 0, previewEl.width, previewEl.height);
    if (!crop) {
      paintToken(ctx, null, null, 6, 6, previewEl.width - 12);
      return;
    }
    loadAssetImage(imgDef.asset)
      .then((img) => {
        ctx.clearRect(0, 0, previewEl.width, previewEl.height);
        paintToken(ctx, img, crop, 6, 6, previewEl.width - 12);
      })
      .catch((err) => setAppearanceStatus(String(err)));
  }

  // Crop window
  const cropDialog = document.getElementById("crop-dialog");
  const cropCanvas = document.getElementById("crop-canvas");
  const cropStatusEl = document.getElementById("crop-status");
  const cropScaleW = document.getElementById("crop-scale-w");
  const cropScaleH = document.getElementById("crop-scale-h");
  /** @type {{ img: HTMLImageElement, asset: string, name: string, crop: any } | null} */
  let cropSession = null;

  function cropFrame() {
    const W = cropCanvas.width;
    const H = cropCanvas.height;
    const side = Math.max(90, Math.min(300, tokenSizeTiles() * 140));
    return { fx: (W - side) / 2, fy: (H - side) / 2, side };
  }

  function syncCropScaleInputs() {
    if (!cropSession) return;
    const size = tokenSizeTiles();
    if (cropScaleW) cropScaleW.value = String(Math.round(cropSession.crop.w * size * 100) / 100);
    if (cropScaleH) cropScaleH.value = String(Math.round(cropSession.crop.h * size * 100) / 100);
  }

  function drawCrop() {
    if (!cropSession || !cropCanvas) return;
    const ctx = cropCanvas.getContext("2d");
    const { fx, fy, side } = cropFrame();
    const { img, crop } = cropSession;
    ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    // Whole image dimmed, so the part outside the frame stays visible while panning
    const rect = IX.cropScreenRect(crop, fx, fy, side);
    ctx.save();
    ctx.globalAlpha = 0.35;
    IX.drawTransformed(ctx, img, rect.x, rect.y, rect.w, rect.h, crop.rotation, crop.flipX, crop.flipY);
    ctx.restore();
    // Token as it will look on the map
    paintToken(ctx, img, crop, fx, fy, side);
    // Frame bbox (snap edges)
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#6ea8fe";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(fx, fy, side, side);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(fx + side / 2, fy + side / 2, side / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "#6ea8fe";
    ctx.lineWidth = 2;
    ctx.stroke();
    syncCropScaleInputs();
  }

  function setCrop(next, msg) {
    if (!cropSession) return;
    cropSession.crop = next;
    drawCrop();
    if (msg && cropStatusEl) cropStatusEl.textContent = msg;
  }

  function openCropWindow(img, asset, name, crop) {
    cropSession = {
      img,
      asset,
      name,
      crop: IX.normalizeCrop(crop) || IX.defaultCrop(img.naturalWidth, img.naturalHeight),
    };
    const size = tokenSizeTiles();
    document.getElementById("crop-title").textContent =
      `Crop token image · frame = ${size} tile${size === 1 ? "" : "s"} across (circle)`;
    if (cropStatusEl) cropStatusEl.textContent = "Drag to pan · wheel to zoom";
    if (typeof cropDialog.showModal === "function") cropDialog.showModal();
    else cropDialog.setAttribute("open", "");
    drawCrop();
  }

  function closeCropWindow() {
    cropSession = null;
    if (typeof cropDialog.close === "function") cropDialog.close();
    else cropDialog.removeAttribute("open");
  }

  async function saveCrop() {
    if (!cropSession) return;
    const image = {
      asset: cropSession.asset,
      name: cropSession.name || undefined,
      crop: IX.cropToJSON(cropSession.crop),
    };
    try {
      await persistAppearance({ image });
      closeCropWindow();
      renderGraphic();
      setAppearanceStatus("Token image saved · map tokens updated");
    } catch (err) {
      if (cropStatusEl) cropStatusEl.textContent = String(err);
    }
  }

  async function importTokenImage(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type || "") && !/\.(png|jpe?g|webp|gif)$/i.test(file.name || "")) {
      setAppearanceStatus("Pick a png / jpg / webp / gif image");
      return;
    }
    setAppearanceStatus("Copying image into campaign assets…");
    const buf = await file.arrayBuffer();
    const safeName = String(file.name || "token").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Asset-Name": `tokens/${actorId}/${safeName}`,
      },
      body: buf,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Upload failed (${res.status})`);
    }
    const data = await res.json();
    const img = await loadAssetImage(data.hash);
    setAppearanceStatus("Adjust the crop, then Save");
    openCropWindow(img, data.hash, file.name || "", null);
  }

  if (btnTokenImport) {
    btnTokenImport.addEventListener("click", () => {
      tokenFileEl.value = "";
      tokenFileEl.click();
    });
  }
  if (tokenFileEl) {
    tokenFileEl.addEventListener("change", () => {
      const f = tokenFileEl.files && tokenFileEl.files[0];
      importTokenImage(f).catch((err) => setAppearanceStatus(String(err)));
    });
  }
  if (btnTokenEdit) {
    btnTokenEdit.addEventListener("click", () => {
      const imgDef = appearance && appearance.image;
      if (!imgDef) return;
      loadAssetImage(imgDef.asset)
        .then((img) => openCropWindow(img, imgDef.asset, imgDef.name || "", imgDef.crop))
        .catch((err) => setAppearanceStatus(String(err)));
    });
  }
  if (btnTokenRemove) {
    btnTokenRemove.addEventListener("click", () => {
      persistAppearance({ image: null })
        .then(() => {
          renderGraphic();
          setAppearanceStatus("Image removed · token is a white circle again");
        })
        .catch((err) => setAppearanceStatus(String(err)));
    });
  }

  if (cropDialog) {
    cropDialog.querySelectorAll("button[data-snap]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const where = btn.getAttribute("data-snap");
        setCrop(IX.snapCrop(cropSession.crop, where), `Snapped ${where}`);
      });
    });
    document.getElementById("crop-zoom-in").addEventListener("click", () =>
      setCrop(IX.zoomCrop(cropSession.crop, 1.1), "Zoom in")
    );
    document.getElementById("crop-zoom-out").addEventListener("click", () =>
      setCrop(IX.zoomCrop(cropSession.crop, 1 / 1.1), "Zoom out")
    );
    document.getElementById("crop-fit").addEventListener("click", () => {
      const { img, crop } = cropSession;
      const odd = crop.rotation === 90 || crop.rotation === 270;
      const fit = odd ? IX.defaultCrop(img.naturalHeight, img.naturalWidth) : IX.defaultCrop(img.naturalWidth, img.naturalHeight);
      setCrop({ ...fit, flipX: crop.flipX, flipY: crop.flipY, rotation: crop.rotation }, "Fit (cover)");
    });
    document.getElementById("crop-scale-apply").addEventListener("click", () => {
      const c = { ...cropSession.crop };
      const { tw, th } = IX.scaleToTiles(c, cropScaleW.value, cropScaleH.value, 1 / tokenSizeTiles(), {
        min: 0.05,
        keepCenter: true,
      });
      setCrop(c, `Scaled to ${tw}×${th} tiles`);
    });
    document.getElementById("crop-flip-h").addEventListener("click", () =>
      setCrop(IX.toggleFlip({ ...cropSession.crop }, "h"), "Flip H")
    );
    document.getElementById("crop-flip-v").addEventListener("click", () =>
      setCrop(IX.toggleFlip({ ...cropSession.crop }, "v"), "Flip V")
    );
    document.getElementById("crop-rotate").addEventListener("click", () => {
      const c = IX.rotateCw({ ...cropSession.crop }, { keepCenter: true });
      setCrop(c, `Rotated to ${c.rotation}°`);
    });
    document.getElementById("crop-cancel").addEventListener("click", closeCropWindow);
    document.getElementById("crop-save").addEventListener("click", () => {
      saveCrop();
    });
    cropDialog.addEventListener("cancel", () => {
      cropSession = null;
    });

    let cropDrag = null;
    cropCanvas.addEventListener("pointerdown", (e) => {
      if (!cropSession) return;
      cropDrag = { x: e.clientX, y: e.clientY, crop: { ...cropSession.crop } };
      cropCanvas.setPointerCapture(e.pointerId);
      cropCanvas.classList.add("dragging");
    });
    cropCanvas.addEventListener("pointermove", (e) => {
      if (!cropDrag || !cropSession) return;
      const { side } = cropFrame();
      const k = cropCanvas.width / cropCanvas.getBoundingClientRect().width || 1;
      setCrop(IX.panCrop(cropDrag.crop, ((e.clientX - cropDrag.x) * k) / side, ((e.clientY - cropDrag.y) * k) / side));
    });
    const endDrag = () => {
      cropDrag = null;
      cropCanvas.classList.remove("dragging");
    };
    cropCanvas.addEventListener("pointerup", endDrag);
    cropCanvas.addEventListener("pointercancel", endDrag);
    cropCanvas.addEventListener(
      "wheel",
      (e) => {
        if (!cropSession) return;
        e.preventDefault();
        const { fx, fy, side } = cropFrame();
        const rect = cropCanvas.getBoundingClientRect();
        const k = cropCanvas.width / rect.width || 1;
        const px = ((e.clientX - rect.left) * k - fx) / side;
        const py = ((e.clientY - rect.top) * k - fy) / side;
        setCrop(IX.zoomCrop(cropSession.crop, e.deltaY < 0 ? 1.1 : 1 / 1.1, px, py));
      },
      { passive: false }
    );
  }

  // Auras
  const auraListEl = document.getElementById("aura-list");
  const btnAuraAdd = document.getElementById("btn-aura-add");
  let auraSaveTimer = null;

  function scheduleAuraSave() {
    clearTimeout(auraSaveTimer);
    auraSaveTimer = setTimeout(() => {
      persistAppearance({ auras: appearance.auras })
        .then(() => setAppearanceStatus("Auras saved · map updated"))
        .catch((err) => setAppearanceStatus(String(err)));
    }, 150);
  }

  /** Live (pre-save) map preview for slider drags. */
  function previewAurasOnMap() {
    notifyMap(actorId, { ...appearance });
  }

  function auraRadiusValue(slot) {
    const k = TA.auraField(slot);
    const v = liveValues[k] != null ? liveValues[k] : actorFields[k];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function renderAuraRadii() {
    if (!auraListEl) return;
    auraListEl.querySelectorAll("input[data-aura-radius]").forEach((inp) => {
      if (document.activeElement === inp) return;
      inp.value = String(auraRadiusValue(Number(inp.getAttribute("data-aura-radius"))));
    });
  }

  function renderAuras() {
    if (!auraListEl || !TA) return;
    const list = TA.normalizeAuras(appearance.auras);
    appearance.auras = list;
    auraListEl.innerHTML = "";
    for (const a of list) {
      const field = TA.auraField(a.slot);
      const formula = isFormulaField(field);
      const row = document.createElement("div");
      row.className = "aura-row";
      row.dataset.slot = String(a.slot);
      row.innerHTML = `
        <label title="Show this emanation"><input type="checkbox" data-k="enabled" ${a.enabled ? "checked" : ""}/> On</label>
        <span class="aura-name">Emanation ${a.slot}</span>
        <label title="${esc(field)} — grid squares beyond the token edge">Radius
          <input type="number" min="0" step="1" data-aura-radius="${a.slot}" value="${esc(String(auraRadiusValue(a.slot)))}" ${formula ? "disabled" : ""}/>
          <code>${esc(field)}</code></label>
        <label>Color <input type="color" data-k="color" value="${esc(a.color)}"/></label>
        <label>Opacity <input type="range" min="0" max="100" step="1" data-k="opacity" value="${Math.round(a.opacity * 100)}"/>
          <span class="op-val">${Math.round(a.opacity * 100)}%</span></label>
        <button type="button" data-k="remove">Remove</button>`;
      const cur = () => appearance.auras.find((x) => x.slot === a.slot);
      row.querySelector('[data-k="enabled"]').addEventListener("change", (e) => {
        cur().enabled = !!e.target.checked;
        previewAurasOnMap();
        scheduleAuraSave();
      });
      row.querySelector('[data-k="color"]').addEventListener("input", (e) => {
        cur().color = e.target.value;
        previewAurasOnMap();
        scheduleAuraSave();
      });
      const op = row.querySelector('[data-k="opacity"]');
      op.addEventListener("input", () => {
        cur().opacity = Math.min(1, Math.max(0, Number(op.value) / 100));
        row.querySelector(".op-val").textContent = `${op.value}%`;
        previewAurasOnMap();
        scheduleAuraSave();
      });
      row.querySelector('[data-k="remove"]').addEventListener("click", () => {
        appearance.auras = TA.removeAura(appearance.auras, a.slot);
        renderAuras();
        previewAurasOnMap();
        scheduleAuraSave();
      });
      const rad = row.querySelector("input[data-aura-radius]");
      rad.addEventListener("change", () => {
        const n = Number(rad.value);
        if (!Number.isFinite(n) || n < 0) {
          setAppearanceStatus("Radius must be a number ≥ 0");
          return;
        }
        // Same field the sheet/automations use
        actorFields[field] = n;
        saveFields({ [field]: n })
          .then(() => {
            recomputeLive();
            renderVisual(false);
            setAppearanceStatus(`Saved ${field}=${n}`);
          })
          .catch((err) => setAppearanceStatus(String(err)));
      });
      auraListEl.appendChild(row);
    }
    if (btnAuraAdd) {
      btnAuraAdd.disabled = !TA.canAddAura(list);
      btnAuraAdd.title = btnAuraAdd.disabled ? "Maximum 3 emanations" : "Add emanation";
    }
  }

  if (btnAuraAdd) {
    btnAuraAdd.addEventListener("click", () => {
      const next = TA.addAura(appearance.auras);
      if (!next) {
        setAppearanceStatus("Maximum 3 emanations");
        renderAuras();
        return;
      }
      appearance.auras = next;
      renderAuras();
      previewAurasOnMap();
      scheduleAuraSave();
    });
  }

  window.__sheetDebug = {
    crop: () => (cropSession ? { ...cropSession.crop } : null),
    appearance: () => appearance,
    liveValues: () => liveValues,
    runNamedFunction: (id) => runNamedFunction(id),
  };

  // --- Zoom / pan on session sheet ---
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) {
      spaceDown = true;
      if (visualWrap) visualWrap.style.cursor = "grab";
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceDown = false;
      if (visualWrap) visualWrap.style.cursor = "";
    }
  });

  if (svgEl) {
    svgEl.addEventListener(
      "wheel",
      (e) => {
        if (!sheetView.base) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const oldS = sheetView.scale;
        const next = Math.min(8, Math.max(0.25, oldS * factor));
        if (next === oldS) return;
        const p = svgPoint(svgEl, e);
        const base = sheetView.base;
        const ox = base.minX + sheetView.x;
        const oy = base.minY + sheetView.y;
        const oldW = base.w / oldS;
        const oldH = base.h / oldS;
        const fracX = oldW ? (p.x - ox) / oldW : 0.5;
        const fracY = oldH ? (p.y - oy) / oldH : 0.5;
        sheetView.scale = next;
        const newW = base.w / next;
        const newH = base.h / next;
        sheetView.x = p.x - fracX * newW - base.minX;
        sheetView.y = p.y - fracY * newH - base.minY;
        applyViewBox();
      },
      { passive: false }
    );

    svgEl.addEventListener("pointerdown", (e) => {
      if (!sheetView.base) return;
      const isMid = e.button === 1;
      const isSpace = spaceDown && e.button === 0;
      if (!isMid && !isSpace) return;
      e.preventDefault();
      const ctm = svgEl.getScreenCTM();
      sheetPan = {
        sx: e.clientX,
        sy: e.clientY,
        vx: sheetView.x,
        vy: sheetView.y,
        a: ctm && ctm.a ? ctm.a : 1,
        d: ctm && ctm.d ? ctm.d : 1,
      };
      svgEl.setPointerCapture(e.pointerId);
    });
    svgEl.addEventListener("pointermove", (e) => {
      if (!sheetPan || !sheetView.base) return;
      sheetView.x = sheetPan.vx - (e.clientX - sheetPan.sx) / sheetPan.a;
      sheetView.y = sheetPan.vy - (e.clientY - sheetPan.sy) / sheetPan.d;
      applyViewBox();
    });
    svgEl.addEventListener("pointerup", () => {
      sheetPan = null;
    });
    svgEl.addEventListener("pointercancel", () => {
      sheetPan = null;
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitToView(), 80);
  });

  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab || "sheet"));
  }

  document.getElementById("save").addEventListener("click", () => {
    save().catch((err) => setStatus(String(err)));
  });
  document.getElementById("save-appearance").addEventListener("click", () => {
    saveAppearance().catch((err) => setAppearanceStatus(String(err)));
  });

  if (btnMechImport) {
    btnMechImport.addEventListener("click", () => {
      showMechImportChooser().catch((err) => setMechanicsStatus(String(err)));
    });
  }
  if (btnMechImportCancel) {
    btnMechImportCancel.addEventListener("click", () => closeMechImport());
  }
  if (btnMechImportConfirm) {
    btnMechImportConfirm.addEventListener("click", () => {
      confirmMechImport().catch((err) => setMechanicsStatus(String(err)));
    });
  }

  // --- 0.7.0: player mode (GM Session Player) + live value refresh ----------
  // ?mode=player: only the Sheet tab (fields, automations, rolls, notes) — the
  // Mechanics/Appearance tabs are GM tools. Both apps poll /api/sheet/<id>/rev
  // every 2 s and pull in values changed elsewhere (player sync, other windows).
  const PLAYER_MODE = params.get("mode") === "player";
  if (PLAYER_MODE) {
    document.body.classList.add("player-mode");
    for (const btn of document.querySelectorAll(".tabs button")) {
      if (btn.dataset.tab !== "sheet") btn.hidden = true;
    }
  }
  let lastRev = null;
  let notesDirty = false;
  textEl.addEventListener("input", () => {
    notesDirty = true;
  });
  document.getElementById("save").addEventListener("click", () => {
    notesDirty = false;
  });
  function isEditing() {
    const ae = document.activeElement;
    return !!(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae !== textEl);
  }
  async function refreshValues() {
    if (!actorId) return;
    const r = await fetch(`/api/sheet/${encodeURIComponent(actorId)}/rev`);
    if (!r.ok) return;
    const { rev } = await r.json();
    if (lastRev === null) {
      lastRev = rev;
      return;
    }
    if (rev === lastRev || isEditing()) return; // retry next tick while typing
    const res = await fetch(`/api/sheet/${encodeURIComponent(actorId)}`);
    if (!res.ok) return;
    const data = await res.json();
    lastRev = rev;
    if (data.fields && typeof data.fields === "object") actorFields = data.fields;
    if (!notesDirty && document.activeElement !== textEl) textEl.value = data.text || "";
    if (data.name && data.name !== actorName) applyActorRename(actorId, data.name);
    renderVisual(false);
    if (PLAYER_MODE && typeof data.pending === "number") {
      setStatus(data.pending ? `${data.pending} change(s) waiting to sync` : "Synced");
    }
  }
  setInterval(() => {
    refreshValues().catch(() => {});
  }, 2000);

  load().catch((err) => setStatus(String(err)));
})();
