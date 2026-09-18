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

  /** @type {any} */
  let appearance = { size_tiles: 1 };
  /** @type {Record<string, any>} */
  let schemaFields = {};
  /** @type {Record<string, any>} */
  let actorFields = {};
  /** @type {object[]} */
  let widgets = [];
  /** @type {{ nodes: object[], edges: object[] }} */
  let graph = { nodes: [], edges: [] };
  /** @type {string|null} schema id from GET /api/sheet */
  let sheetId = null;
  /** @type {Record<string, number|string>} */
  let liveValues = {};
  /** @type {Record<string, boolean>} */
  let toggleState = Object.create(null);

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

  function mechToggleKey(name) {
    return `mech:${name}`;
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
    const names = namedFunctionsOnSheet();
    if (!names.length) {
      mechanicsListEl.innerHTML =
        `<p class="mech-empty">No named functions on this sheet — add Function entries in Sheet builder, or Import… from the campaign library.</p>`;
      return;
    }
    let html = "";
    for (const name of names) {
      const pressed = !!toggleState[mechToggleKey(name)];
      html += `<div class="mech-row" data-fn="${esc(name)}">`;
      html += `<span class="mech-name">${esc(name)}</span>`;
      html += `<button type="button" class="mech-trigger" data-action="trigger">Trigger</button>`;
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
            const key = mechToggleKey(name);
            const next = !toggleState[key];
            toggleState[key] = next;
            runNamedFunction(name, {
              mode: "toggle",
              label: name,
              entryValue: next ? 1 : 0,
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
        const pressed = mode === "toggle" && !!toggleState[w.id];
        const sub = buttonSubtitle(w);
        html += `<g class="sheet-btn${pressed ? " pressed" : ""}" data-id="${esc(w.id)}" data-mode="${esc(mode)}" data-function="${esc(functionId)}" style="cursor:pointer">`;
        html += `<rect class="widget-button${pressed ? " toggle-on" : ""}" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="10" />`;
        html += `<text class="widget-btn-label" x="${cx}" y="${cy - 4}">${esc(label)}</text>`;
        html += `<text class="widget-btn-sub" x="${cx}" y="${cy + 12}">${esc(sub)}</text>`;
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
        const { mode } = normalizeButton(w);
        if (mode === "toggle") {
          const next = !toggleState[id];
          toggleState[id] = next;
          // Always run: on → entryValue 1, off → entryValue 0 (clears proficiency writes)
          runButtonFunction(w, { entryValue: next ? 1 : 0 }).catch((err) =>
            setStatus(String(err))
          );
        } else {
          runButtonFunction(w).catch((err) => setStatus(String(err)));
        }
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
            renderVisual(false);
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
          }
        : { nodes: [], edges: [] };

    renderVisual(true);
    renderMechanics();
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

  load().catch((err) => setStatus(String(err)));
})();
