(() => {
  "use strict";

  // --- DOM ---
  const sheetSelect = document.getElementById("sheet-select");
  const sheetNameEl = document.getElementById("sheet-name");
  const statusEl = document.getElementById("status");
  const btnSave = document.getElementById("btn-save");
  const btnCompile = document.getElementById("btn-compile");
  const btnReload = document.getElementById("btn-reload");
  const displaySvg = document.getElementById("display-svg");
  const graphSvg = document.getElementById("graph-svg");
  const displayProps = document.getElementById("display-props");
  const graphProps = document.getElementById("graph-props");
  const splitter = document.getElementById("splitter");
  const paneDisplay = document.getElementById("pane-display");
  const paneGraph = document.getElementById("pane-graph");

  /** @type {{
   *   sheet_id: string,
   *   name: string,
   *   fields: Record<string, object>,
   *   permissions?: object,
   *   layout: { widgets: object[] },
   *   graph: { nodes: object[], edges: object[] }
   * }} */
  let doc = emptyDoc("player");

  let displayTool = "select";
  let selectedWidgetId = null;
  let selectedNodeId = null;
  /** @type {Set<string>} */
  let selectedNodeIds = new Set();
  /** Selected compressed block id */
  let selectedCollapsedId = null;
  let selectedEdgeId = null;

  /** Display drag state */
  let dispDrag = null;
  /** Display canvas zoom/pan (session-only, not persisted) */
  let displayView = { scale: 1, x: 0, y: 0 };
  let displayPan = null; // { ox, oy, vx, vy } or null
  /** Automations canvas zoom/pan (independent of displayView) */
  let graphView = { scale: 1, x: 0, y: 0 };
  let graphPan = null;
  let spaceDown = false;
  /** Mode for newly added buttons */
  let buttonAddMode = "trigger";
  /** Graph tool: select (pan empty / move / wire) */
  let graphTool = "select";
  /** Graph drag / wire state */
  let graphDrag = null;
  let wireFrom = null; // { nodeId, x, y } world coords

  let uidCounter = 1;
  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;
  }

  function emptyDoc(sheetId) {
    return {
      sheet_id: sheetId || "player",
      name: sheetId || "player",
      fields: {},
      permissions: null,
      layout: { widgets: [] },
      graph: { nodes: [], edges: [], collapsed: [] },
    };
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = kind || "";
  }

  function qsSheetId() {
    const p = new URLSearchParams(location.search);
    return (p.get("sheet") || p.get("id") || "player").trim() || "player";
  }

  // --- Field helpers ---
  function fieldIds() {
    return Object.keys(doc.fields || {}).sort();
  }

  const RT = window.SheetRuntime || null;

  /**
   * Preview field values from schema defaults + closed formulas (mirrors session recomputeLive).
   * @returns {Record<string, number|string>}
   */
  function previewFieldValues() {
    /** @type {Record<string, number|string>} */
    const values = {};
    /** @type {Record<string, string>} */
    const formulas = {};

    for (const [k, def] of Object.entries(doc.fields || {})) {
      if (def && def.formula) {
        formulas[k] = String(def.formula);
      } else {
        let v = def && def.default != null ? def.default : 0;
        if (v === "") v = 0;
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

    const evalFn =
      RT && typeof RT.evalClosedFormula === "function"
        ? (expr, env) => RT.evalClosedFormula(expr, env)
        : null;

    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (const [k, f] of Object.entries(formulas)) {
        try {
          if (!evalFn) {
            values[k] = 0;
            continue;
          }
          const n = evalFn(f, /** @type {any} */ (values));
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
    return values;
  }

  function fieldDefault(fid) {
    const f = doc.fields[fid];
    if (!f) return 0;
    if (f.formula) {
      const preview = previewFieldValues();
      const v = preview[fid];
      if (v === undefined || v === null || v === "") return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    const d = f.default;
    if (d === undefined || d === null || d === "") return 0;
    return d;
  }

  function ensureField(fid, opts) {
    if (!fid) return;
    if (!doc.fields[fid]) {
      doc.fields[fid] = {
        type: (opts && opts.type) || "integer",
        visibility: "player_visible",
        editable: (opts && opts.editable) != null ? opts.editable : "player_editable",
        default: (opts && opts.default) != null ? opts.default : 0,
      };
    }
    if (opts && opts.formula != null) {
      doc.fields[fid].formula = opts.formula;
      doc.fields[fid].editable = false;
    }
  }

  // --- Seed sample STR → STR_mod graph ---
  function seedStrModGraph() {
    ensureField("STR", { default: 10 });
    ensureField("STR_mod", { editable: false, formula: "floor((STR - 10) / 2)" });
    const nStr = uid("n");
    const n10 = uid("n");
    const nSub = uid("n");
    const n2 = uid("n");
    const nDiv = uid("n");
    const nFloor = uid("n");
    const nOut = uid("n");
    doc.graph.nodes = [
      { id: nStr, kind: "field", field: "STR", role: "source", x: 40, y: 60 },
      { id: n10, kind: "const", value: 10, x: 40, y: 160 },
      { id: nSub, kind: "op", op: "-", x: 200, y: 100 },
      { id: n2, kind: "const", value: 2, x: 200, y: 220 },
      { id: nDiv, kind: "op", op: "/", x: 360, y: 140 },
      { id: nFloor, kind: "op", op: "floor", x: 520, y: 140 },
      { id: nOut, kind: "field", field: "STR_mod", role: "output", x: 680, y: 140 },
    ];
    doc.graph.edges = [
      { id: uid("e"), from: nStr, to: nSub, toPort: 0 },
      { id: uid("e"), from: n10, to: nSub, toPort: 1 },
      { id: uid("e"), from: nSub, to: nDiv, toPort: 0 },
      { id: uid("e"), from: n2, to: nDiv, toPort: 1 },
      { id: uid("e"), from: nDiv, to: nFloor, toPort: 0 },
      { id: uid("e"), from: nFloor, to: nOut, toPort: 0 },
    ];
    if (!doc.layout.widgets.length) {
      doc.layout.widgets = [
        { id: uid("w"), shape: "box", field: "STR", x: 40, y: 40, w: 72, h: 56 },
        { id: uid("w"), shape: "circle", field: "STR_mod", x: 160, y: 40, w: 64, h: 64 },
      ];
    }
  }

  // --- Formula compile (closed language) ---
  function arityOf(node) {
    if (RT && typeof RT.arityOf === "function") return RT.arityOf(node);
    if (!node) return 0;
    if (node.kind === "op") {
      const op = node.op;
      if (op === "floor" || op === "not") return 1;
      if (op === "if") return 3;
      return 2;
    }
    if (node.kind === "field" && node.role === "output") return 1;
    // Optional trigger wire so entry → roll is connectable; value ignored at runtime
    if (node.kind === "roll") return 1;
    if (node.kind === "send_to_chat" || node.kind === "chat") return 1;
    return 0;
  }

  function hasOutputPort(node) {
    if (!node) return false;
    if (node.kind === "field" && node.role === "output") return false;
    if (node.kind === "send_to_chat" || node.kind === "chat") return false;
    return true;
  }

  /**
   * Compile graph into formulas for each output field node.
   * @returns {{ formulas: Record<string,string>, error?: string }}
   */
  function compileGraph(graph) {
    const nodes = (graph && graph.nodes) || [];
    const edges = (graph && graph.edges) || [];
    const byId = Object.create(null);
    for (const n of nodes) byId[n.id] = n;

    /** @type {Record<string, {from:string, toPort:number}[]>} */
    const incoming = Object.create(null);
    /** @type {Record<string, string[]>} */
    const outgoing = Object.create(null);
    for (const n of nodes) {
      incoming[n.id] = [];
      outgoing[n.id] = [];
    }
    for (const e of edges) {
      if (!byId[e.from] || !byId[e.to]) continue;
      incoming[e.to].push({ from: e.from, toPort: e.toPort == null ? 0 : e.toPort });
      outgoing[e.from].push(e.to);
    }
    for (const id of Object.keys(incoming)) {
      incoming[id].sort((a, b) => a.toPort - b.toPort);
    }

    // Cycle detect via DFS
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = Object.create(null);
    for (const n of nodes) color[n.id] = WHITE;
    function hasCycleFrom(id) {
      color[id] = GRAY;
      for (const to of outgoing[id] || []) {
        if (color[to] === GRAY) return true;
        if (color[to] === WHITE && hasCycleFrom(to)) return true;
      }
      color[id] = BLACK;
      return false;
    }
    for (const n of nodes) {
      if (color[n.id] === WHITE && hasCycleFrom(n.id)) {
        return { formulas: {}, error: "Cycle detected in automation graph" };
      }
    }

    const memo = Object.create(null);
    const visiting = Object.create(null);

    function exprOf(nodeId) {
      if (memo[nodeId] != null) return memo[nodeId];
      if (visiting[nodeId]) throw new Error("Cycle while compiling");
      visiting[nodeId] = true;
      const n = byId[nodeId];
      if (!n) throw new Error(`Missing node ${nodeId}`);
      let out;
      if (n.kind === "field") {
        const fname = String(n.field || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fname)) {
          throw new Error(`Invalid field name on node ${nodeId}`);
        }
        // Source fields are just the name; output sinks compile from their input
        if (n.role === "output") {
          const ins = incoming[nodeId] || [];
          if (ins.length !== 1) {
            throw new Error(`Output field "${fname}" needs exactly one input wire`);
          }
          out = exprOf(ins[0].from);
        } else {
          out = fname;
        }
      } else if (n.kind === "const") {
        const v = Number(n.value);
        if (!Number.isFinite(v)) throw new Error(`Bad constant on ${nodeId}`);
        out = String(v);
      } else if (n.kind === "op") {
        const op = n.op;
        const ins = incoming[nodeId] || [];
        function portFrom(port, fallbackIdx) {
          return ins.find((x) => x.toPort === port) || ins[fallbackIdx];
        }
        if (op === "floor" || op === "not") {
          if (ins.length < 1) throw new Error(`${op} needs one input`);
          const a = portFrom(0, 0);
          out = `${op}(${exprOf(a.from)})`;
        } else if (op === "if") {
          if (ins.length < 3) throw new Error("if needs three inputs (cond, then, else)");
          const c = portFrom(0, 0);
          const t = portFrom(1, 1);
          const e = portFrom(2, 2);
          out = `if(${exprOf(c.from)}, ${exprOf(t.from)}, ${exprOf(e.from)})`;
        } else if (op === "and" || op === "or") {
          if (ins.length < 2) throw new Error(`${op} needs two inputs`);
          const a = portFrom(0, 0);
          const b = portFrom(1, 1);
          out = `${op}(${exprOf(a.from)}, ${exprOf(b.from)})`;
        } else if (
          op === "+" ||
          op === "-" ||
          op === "*" ||
          op === "/" ||
          op === "==" ||
          op === "!=" ||
          op === "<" ||
          op === ">" ||
          op === "<=" ||
          op === ">="
        ) {
          if (ins.length < 2) throw new Error(`Operator ${op} needs two inputs`);
          const a = portFrom(0, 0);
          const b = portFrom(1, 1);
          out = `(${exprOf(a.from)} ${op} ${exprOf(b.from)})`;
        } else {
          throw new Error(`Unknown op: ${op}`);
        }
      } else if (
        n.kind === "roll" ||
        n.kind === "entry" ||
        n.kind === "function" ||
        n.kind === "send_to_chat" ||
        n.kind === "chat"
      ) {
        throw new Error(
          "Roll/entry/chat nodes are runtime-only and cannot feed formula field outputs"
        );
      } else {
        throw new Error(`Unknown node kind: ${n.kind}`);
      }
      visiting[nodeId] = false;
      memo[nodeId] = out;
      return out;
    }

    const formulas = {};
    try {
      for (const n of nodes) {
        if (n.kind === "field" && n.role === "output") {
          const fname = String(n.field || "").trim();
          formulas[fname] = exprOf(n.id);
        }
      }
    } catch (err) {
      return { formulas: {}, error: err.message || String(err) };
    }
    return { formulas };
  }

  function applyFormulasToFields(formulas) {
    for (const [fid, formula] of Object.entries(formulas)) {
      ensureField(fid, { editable: false });
      doc.fields[fid].formula = formula;
      doc.fields[fid].editable = false;
    }
  }

  // --- API ---
  async function listSheets() {
    const res = await fetch("/api/sheet-builder");
    if (!res.ok) throw new Error(`list sheets: ${res.status}`);
    return res.json();
  }

  async function loadBuilder(id) {
    setStatus(`Loading ${id}…`);
    const res = await fetch(`/api/sheet-builder/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `load failed: ${res.status}`);
    }
    const data = await res.json();
    doc = normalizeDoc(data);
    // Seed sample automation if graph empty but STR/STR_mod exist or sheet is player
    if ((!doc.graph.nodes || !doc.graph.nodes.length) && (doc.sheet_id === "player" || doc.fields.STR)) {
      seedStrModGraph();
    }
    selectedWidgetId = null;
    selectedNodeId = null;
    selectedNodeIds = new Set();
    selectedCollapsedId = null;
    selectedEdgeId = null;
    sheetNameEl.value = doc.name || doc.sheet_id;
    renderAll();
    const src = data._source || "scratch";
    setStatus(`Loaded ${doc.sheet_id} (${src})`, "ok");
  }

  function migrateWidget(w) {
    if (!w || w.shape !== "button") return w;
    if (w.action && w.action.type === "roll") {
      if (w.mode == null) w.mode = "trigger";
      if (w.function_id == null) w.function_id = "";
      delete w.action;
    }
    if (w.mode !== "toggle") w.mode = "trigger";
    if (w.function_id == null) w.function_id = "";
    if (w.label == null) w.label = "Button";
    return w;
  }

  function normalizeDoc(raw) {
    const d = emptyDoc(raw.sheet_id || "player");
    d.sheet_id = raw.sheet_id || d.sheet_id;
    d.name = raw.name || d.sheet_id;
    d.fields = raw.fields && typeof raw.fields === "object" ? { ...raw.fields } : {};
    d.permissions = raw.permissions || null;
    d.layout = {
      widgets: Array.isArray(raw.layout && raw.layout.widgets)
        ? raw.layout.widgets.map((w) => migrateWidget({ ...w }))
        : [],
    };
    d.graph = {
      nodes: Array.isArray(raw.graph && raw.graph.nodes)
        ? raw.graph.nodes.map((n) => ({ ...n }))
        : [],
      edges: Array.isArray(raw.graph && raw.graph.edges)
        ? raw.graph.edges.map((e) => ({ ...e, id: e.id || uid("e") }))
        : [],
      collapsed: normalizeCollapsed(
        raw.graph && Array.isArray(raw.graph.collapsed) ? raw.graph.collapsed : []
      ),
    };
    return d;
  }

  function normalizeCollapsed(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== "object") continue;
      const id = c.id != null ? String(c.id) : uid("c");
      const name = c.name != null ? String(c.name) : "";
      const nodeIds = Array.isArray(c.nodeIds)
        ? c.nodeIds.map((x) => String(x)).filter(Boolean)
        : [];
      if (!nodeIds.length) continue;
      out.push({
        id,
        name,
        nodeIds,
        x: Number(c.x) || 0,
        y: Number(c.y) || 0,
        w: c.w != null ? Number(c.w) : undefined,
        h: c.h != null ? Number(c.h) : undefined,
      });
    }
    return out;
  }

  function payload() {
    doc.name = sheetNameEl.value.trim() || doc.sheet_id;
    // Live-compile formulas into fields for save preview
    const compiled = compileGraph(doc.graph);
    if (!compiled.error) applyFormulasToFields(compiled.formulas);
    return {
      sheet_id: doc.sheet_id,
      name: doc.name,
      fields: doc.fields,
      permissions: doc.permissions,
      layout: doc.layout,
      graph: doc.graph,
    };
  }

  async function saveBuilder() {
    const body = payload();
    const compiled = compileGraph(doc.graph);
    if (compiled.error) {
      setStatus(`Saved with graph error: ${compiled.error}`, "warn");
    }
    const res = await fetch(`/api/sheet-builder/${encodeURIComponent(doc.sheet_id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `save failed: ${res.status}`);
    }
    if (!compiled.error) setStatus(`Saved editor-scratch/sheets/${doc.sheet_id}.builder.json`, "ok");
    renderAll();
  }

  async function compileBuilder() {
    const body = payload();
    const compiled = compileGraph(doc.graph);
    if (compiled.error) {
      setStatus(compiled.error, "err");
      renderGraphProps();
      return;
    }
    applyFormulasToFields(compiled.formulas);
    body.fields = doc.fields;
    const res = await fetch(
      `/api/sheet-builder/${encodeURIComponent(doc.sheet_id)}/compile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `compile failed: ${res.status}`);
    }
    const data = await res.json();
    const formulas = Object.entries(compiled.formulas)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    setStatus(
      `Compiled → build/sheets/${doc.sheet_id}.yaml` +
        (formulas ? ` [${formulas}]` : " (no output formulas)"),
      "ok"
    );
    renderAll();
    return data;
  }

  // --- Splitter ---
  (function initSplitter() {
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      splitter.classList.add("dragging");
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const split = document.getElementById("split");
      const rect = split.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.min(75, Math.max(25, (x / rect.width) * 100));
      paneDisplay.style.width = `${pct}%`;
      paneGraph.style.width = `${100 - pct}%`;
    });
    const end = () => {
      dragging = false;
      splitter.classList.remove("dragging");
    };
    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);
  })();

  // --- Display canvas ---
  function svgPoint(svg, evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function displayWorldPoint(evt) {
    const p = svgPoint(displaySvg, evt);
    return {
      x: (p.x - displayView.x) / displayView.scale,
      y: (p.y - displayView.y) / displayView.scale,
    };
  }

  function applyDisplayTransform() {
    const g = displaySvg.querySelector("#display-root");
    if (g) {
      g.setAttribute(
        "transform",
        `translate(${displayView.x},${displayView.y}) scale(${displayView.scale})`
      );
    }
  }

  function setDisplayView(next) {
    displayView = {
      scale: Math.min(8, Math.max(0.2, next.scale != null ? next.scale : displayView.scale)),
      x: next.x != null ? next.x : displayView.x,
      y: next.y != null ? next.y : displayView.y,
    };
    applyDisplayTransform();
  }

  function zoomDisplayAt(svgX, svgY, factor) {
    const old = displayView.scale;
    const scale = Math.min(8, Math.max(0.2, old * factor));
    if (scale === old) return;
    // Keep world point under (svgX,svgY) stable
    const wx = (svgX - displayView.x) / old;
    const wy = (svgY - displayView.y) / old;
    setDisplayView({
      scale,
      x: svgX - wx * scale,
      y: svgY - wy * scale,
    });
  }

  function renderDisplay() {
    const widgets = doc.layout.widgets || [];
    let html = `<g id="display-root" transform="translate(${displayView.x},${displayView.y}) scale(${displayView.scale})">`;
    for (const w of widgets) {
      const sel = w.id === selectedWidgetId ? " widget-selected" : "";
      const cx = w.x + w.w / 2;
      const cy = w.y + w.h / 2;
      if (w.shape === "button") {
        const label = w.label || "Button";
        const mode = w.mode === "toggle" ? "toggle" : "trigger";
        const fid = w.function_id || "";
        const sub = fid ? `${mode} · ${fid}` : mode;
        html += `<g class="widget" data-id="${esc(w.id)}">`;
        html += `<rect class="widget-button${sel}" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="10" data-id="${esc(w.id)}" />`;
        html += `<text class="widget-value" x="${cx}" y="${cy - 2}">${esc(label)}</text>`;
        html += `<text class="widget-label" x="${cx}" y="${cy + 14}">${esc(sub)}</text>`;
        html += `</g>`;
      } else if (w.shape === "circle") {
        const r = Math.min(w.w, w.h) / 2;
        const val = fieldDefault(w.field);
        const label = w.field || "(field)";
        html += `<g class="widget" data-id="${esc(w.id)}" transform="translate(0,0)">`;
        html += `<circle class="widget-circle${sel}" cx="${cx}" cy="${cy}" r="${r}" data-id="${esc(w.id)}" />`;
        html += `<text class="widget-value" x="${cx}" y="${cy}">${esc(String(val))}</text>`;
        html += `<text class="widget-label" x="${cx}" y="${cy + r + 14}">${esc(label)}</text>`;
        html += `</g>`;
      } else {
        const val = fieldDefault(w.field);
        const label = w.field || "(field)";
        html += `<g class="widget" data-id="${esc(w.id)}">`;
        html += `<rect class="widget-box${sel}" x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="6" data-id="${esc(w.id)}" />`;
        html += `<text class="widget-value" x="${cx}" y="${cy}">${esc(String(val))}</text>`;
        html += `<text class="widget-label" x="${cx}" y="${w.y + w.h + 14}">${esc(label)}</text>`;
        html += `</g>`;
      }
    }
    html += `</g>`;
    displaySvg.innerHTML = html;
    renderDisplayProps();
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function findWidget(id) {
    return (doc.layout.widgets || []).find((w) => w.id === id);
  }

  function hitWidget(x, y) {
    const widgets = doc.layout.widgets || [];
    for (let i = widgets.length - 1; i >= 0; i--) {
      const w = widgets[i];
      if (w.shape === "circle") {
        const cx = w.x + w.w / 2;
        const cy = w.y + w.h / 2;
        const r = Math.min(w.w, w.h) / 2;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) return w;
      } else if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) {
        return w;
      }
    }
    return null;
  }

  function renderDisplayProps() {
    const w = selectedWidgetId ? findWidget(selectedWidgetId) : null;
    if (!w) {
      displayProps.innerHTML = `<span class="hint">Select a widget to bind a field · tool: ${displayTool} · wheel zoom · mid/space/empty drag pan</span>`;
      return;
    }
    if (w.shape === "button") {
      const label = w.label != null ? w.label : "Button";
      const mode = w.mode === "toggle" ? "toggle" : "trigger";
      const fid = w.function_id != null ? w.function_id : "";
      const fnHint =
        mode === "toggle"
          ? "function id = field name to flip 0/1"
          : "function id = automation entry name";
      const fnPlaceholder = mode === "toggle" ? "field_name" : "function_id";
      displayProps.innerHTML = `
        <label>Label <input type="text" id="prop-label" value="${esc(label)}" style="width:8rem" /></label>
        <label>Mode <select id="prop-mode">
          <option value="trigger"${mode === "trigger" ? " selected" : ""}>trigger</option>
          <option value="toggle"${mode === "toggle" ? " selected" : ""}>toggle</option>
        </select></label>
        <label>Function <input type="text" id="prop-fn" value="${esc(fid)}" placeholder="${esc(fnPlaceholder)}" style="width:8rem" /></label>
        <span class="hint">button · ${esc(mode)}${fid ? " · " + esc(fid) : ""} · ${esc(fnHint)} @ (${Math.round(w.x)},${Math.round(w.y)})</span>
      `;
      const lab = document.getElementById("prop-label");
      const modeEl = document.getElementById("prop-mode");
      const fnEl = document.getElementById("prop-fn");
      lab.addEventListener("change", () => {
        w.label = lab.value.trim() || "Button";
        renderDisplay();
      });
      modeEl.addEventListener("change", () => {
        w.mode = modeEl.value === "toggle" ? "toggle" : "trigger";
        renderDisplay();
      });
      fnEl.addEventListener("change", () => {
        w.function_id = fnEl.value.trim();
        renderDisplay();
      });
      return;
    }
    const fdef = doc.fields[w.field] || {};
    const isFormula = !!fdef.formula;
    const hasField = !!(w.field && String(w.field).trim());
    displayProps.innerHTML = `
      <label>Field <input type="text" id="prop-field" value="${esc(w.field || "")}" placeholder="FIELD_ID" style="width:8rem" /></label>
      <label>Value <input type="number" id="prop-value" ${!hasField || isFormula ? "disabled" : ""} value="${esc(String(hasField && fdef.default != null ? fdef.default : 0))}" style="width:5rem" title="${isFormula ? "Formula field (read-only)" : "Editable default"}" /></label>
      ${isFormula ? `<span class="formula-preview">${esc(fdef.formula)}</span>` : ""}
      <span class="hint">${w.shape} @ (${Math.round(w.x)},${Math.round(w.y)})</span>
    `;
    const fieldInput = document.getElementById("prop-field");
    const val = document.getElementById("prop-value");
    fieldInput.addEventListener("change", () => {
      const id = fieldInput.value.trim();
      if (id && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
        setStatus("Field id must be identifier-like", "err");
        return;
      }
      w.field = id;
      if (id) ensureField(id);
      renderDisplay();
    });
    if (val && hasField && !isFormula) {
      val.addEventListener("change", () => {
        ensureField(w.field);
        doc.fields[w.field].default = Number(val.value) || 0;
        renderDisplay();
      });
    }
  }

  const btnAddModeEl = document.getElementById("btn-add-mode");
  if (btnAddModeEl) {
    btnAddModeEl.addEventListener("change", () => {
      buttonAddMode = btnAddModeEl.value === "toggle" ? "toggle" : "trigger";
    });
  }

  displaySvg.addEventListener("pointerdown", (e) => {
    const screen = svgPoint(displaySvg, e);
    const p = displayWorldPoint(e);
    const wantPan =
      e.button === 1 ||
      (e.button === 0 && spaceDown) ||
      (e.button === 0 && displayTool === "select" && !hitWidget(p.x, p.y) && !spaceDown);

    if (wantPan && displayTool !== "box" && displayTool !== "circle" && displayTool !== "button" && displayTool !== "delete") {
      // Empty-space pan only when select and no hit; middle/space always
      if (e.button === 1 || spaceDown || !hitWidget(p.x, p.y)) {
        e.preventDefault();
        displayPan = {
          sx: e.clientX,
          sy: e.clientY,
          vx: displayView.x,
          vy: displayView.y,
        };
        displaySvg.setPointerCapture(e.pointerId);
        selectedWidgetId = null;
        renderDisplay();
        return;
      }
    }

    if (displayTool === "box" || displayTool === "circle" || displayTool === "button") {
      let w;
      if (displayTool === "button") {
        const mode =
          (btnAddModeEl && btnAddModeEl.value === "toggle") || buttonAddMode === "toggle"
            ? "toggle"
            : "trigger";
        w = {
          id: uid("w"),
          shape: "button",
          label: "Button",
          mode,
          function_id: "",
          x: p.x - 44,
          y: p.y - 22,
          w: 88,
          h: 44,
        };
      } else {
        w = {
          id: uid("w"),
          shape: displayTool === "circle" ? "circle" : "box",
          field: "",
          x: p.x - 36,
          y: p.y - 28,
          w: displayTool === "circle" ? 64 : 72,
          h: displayTool === "circle" ? 64 : 56,
        };
      }
      doc.layout.widgets.push(w);
      selectedWidgetId = w.id;
      displayTool = "select";
      syncDisplayToolButtons();
      renderDisplay();
      return;
    }
    const hit = hitWidget(p.x, p.y);
    if (displayTool === "delete") {
      if (hit) {
        doc.layout.widgets = doc.layout.widgets.filter((x) => x.id !== hit.id);
        selectedWidgetId = null;
        renderDisplay();
      }
      return;
    }
    selectedWidgetId = hit ? hit.id : null;
    if (hit) {
      dispDrag = {
        id: hit.id,
        ox: p.x - hit.x,
        oy: p.y - hit.y,
      };
      displaySvg.setPointerCapture(e.pointerId);
    } else if (displayTool === "select") {
      displayPan = {
        sx: e.clientX,
        sy: e.clientY,
        vx: displayView.x,
        vy: displayView.y,
      };
      displaySvg.setPointerCapture(e.pointerId);
    }
    renderDisplay();
  });

  displaySvg.addEventListener("pointermove", (e) => {
    if (displayPan) {
      const ctm = displaySvg.getScreenCTM();
      const a = ctm && ctm.a ? ctm.a : 1;
      const d = ctm && ctm.d ? ctm.d : 1;
      setDisplayView({
        scale: displayView.scale,
        x: displayPan.vx + (e.clientX - displayPan.sx) / a,
        y: displayPan.vy + (e.clientY - displayPan.sy) / d,
      });
      return;
    }
    if (!dispDrag) return;
    const p = displayWorldPoint(e);
    const w = findWidget(dispDrag.id);
    if (!w) return;
    w.x = p.x - dispDrag.ox;
    w.y = p.y - dispDrag.oy;
    renderDisplay();
  });

  displaySvg.addEventListener("pointerup", () => {
    dispDrag = null;
    displayPan = null;
  });
  displaySvg.addEventListener("pointercancel", () => {
    dispDrag = null;
    displayPan = null;
  });

  displaySvg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const screen = svgPoint(displaySvg, e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomDisplayAt(screen.x, screen.y, factor);
    },
    { passive: false }
  );

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) {
      spaceDown = true;
      displaySvg.style.cursor = "grab";
      if (graphSvg) graphSvg.style.cursor = "grab";
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceDown = false;
      displaySvg.style.cursor = "";
      if (graphSvg) graphSvg.style.cursor = "";
    }
  });

  const btnZoomIn = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnZoomReset = document.getElementById("btn-zoom-reset");
  if (btnZoomIn) {
    btnZoomIn.addEventListener("click", () => {
      const wrap = document.getElementById("display-wrap");
      const rect = wrap.getBoundingClientRect();
      zoomDisplayAt(rect.width / 2, rect.height / 2, 1.2);
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener("click", () => {
      const wrap = document.getElementById("display-wrap");
      const rect = wrap.getBoundingClientRect();
      zoomDisplayAt(rect.width / 2, rect.height / 2, 1 / 1.2);
    });
  }
  if (btnZoomReset) {
    btnZoomReset.addEventListener("click", () => {
      setDisplayView({ scale: 1, x: 0, y: 0 });
    });
  }

  function syncDisplayToolButtons() {
    document.querySelectorAll("#display-tools [data-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-tool") === displayTool);
    });
  }

  document.querySelectorAll("#display-tools [data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-tool");
      if (t === "delete") {
        if (selectedWidgetId) {
          doc.layout.widgets = doc.layout.widgets.filter((x) => x.id !== selectedWidgetId);
          selectedWidgetId = null;
          renderDisplay();
        } else {
          displayTool = "delete";
          syncDisplayToolButtons();
          setStatus("Click a widget to delete", "warn");
        }
        return;
      }
      displayTool = t;
      syncDisplayToolButtons();
    });
  });

  // --- Graph canvas zoom/pan (independent of displayView) ---
  function graphWorldPoint(evt) {
    const p = svgPoint(graphSvg, evt);
    return {
      x: (p.x - graphView.x) / graphView.scale,
      y: (p.y - graphView.y) / graphView.scale,
    };
  }

  function applyGraphTransform() {
    const g = graphSvg.querySelector("#graph-root");
    if (g) {
      g.setAttribute(
        "transform",
        `translate(${graphView.x},${graphView.y}) scale(${graphView.scale})`
      );
    }
  }

  function setGraphView(next) {
    graphView = {
      scale: Math.min(8, Math.max(0.2, next.scale != null ? next.scale : graphView.scale)),
      x: next.x != null ? next.x : graphView.x,
      y: next.y != null ? next.y : graphView.y,
    };
    applyGraphTransform();
  }

  function zoomGraphAt(svgX, svgY, factor) {
    const old = graphView.scale;
    const scale = Math.min(8, Math.max(0.2, old * factor));
    if (scale === old) return;
    const wx = (svgX - graphView.x) / old;
    const wy = (svgY - graphView.y) / old;
    setGraphView({
      scale,
      x: svgX - wx * scale,
      y: svgY - wy * scale,
    });
  }

  // --- Graph canvas ---
  const NODE_W = 120;
  const NODE_H = 52;

  function nodeById(id) {
    return (doc.graph.nodes || []).find((n) => n.id === id);
  }

  function portPos(node, which, portIndex) {
    // which: 'out' | 'in'
    const x = node.x;
    const y = node.y;
    if (which === "out") {
      return { x: x + NODE_W, y: y + NODE_H / 2 };
    }
    const arity = Math.max(1, arityOf(node) || (node.kind === "field" && node.role === "output" ? 1 : 1));
    const idx = portIndex == null ? 0 : portIndex;
    const span = NODE_H * 0.6;
    const start = y + (NODE_H - span) / 2;
    const step = arity <= 1 ? 0 : span / (arity - 1);
    return { x: x, y: start + idx * step + (arity <= 1 ? span / 2 : 0) };
  }

  function nodeLabel(n) {
    if (n.kind === "field") {
      return n.role === "output" ? `⟹ ${n.field || "?"}` : n.field || "field";
    }
    if (n.kind === "const") return String(n.value);
    if (n.kind === "op") {
      if (n.op === "floor") return "floor";
      if (n.op === "if") return "if";
      if (n.op === "and") return "and";
      if (n.op === "or") return "or";
      if (n.op === "not") return "not";
      return n.op;
    }
    if (n.kind === "roll") return `d${n.sides != null ? n.sides : 20}`;
    if (n.kind === "entry" || n.kind === "function") return n.name || "fn";
    if (n.kind === "send_to_chat" || n.kind === "chat") {
      return n.label ? String(n.label) : "chat";
    }
    return n.kind;
  }

  function nodeSub(n) {
    if (n.kind === "field") return n.role === "output" ? "output" : "field";
    if (n.kind === "const") return "const";
    if (n.kind === "op") {
      const op = n.op;
      if (op === "if") return "cond · then · else";
      if (op === "and" || op === "or" || op === "not") return "logic";
      if (
        op === "==" ||
        op === "!=" ||
        op === "<" ||
        op === ">" ||
        op === "<=" ||
        op === ">="
      )
        return "compare";
      return "op";
    }
    if (n.kind === "roll") return "roll";
    if (n.kind === "entry" || n.kind === "function") return "entry";
    if (n.kind === "send_to_chat" || n.kind === "chat") return "send to chat";
    return "";
  }


  function ensureCollapsedArray() {
    if (!doc.graph.collapsed || !Array.isArray(doc.graph.collapsed)) {
      doc.graph.collapsed = [];
    }
    return doc.graph.collapsed;
  }

  function collapsedById(id) {
    return ensureCollapsedArray().find((c) => c.id === id) || null;
  }

  function memberIdSet() {
    const hidden = new Set();
    for (const c of ensureCollapsedArray()) {
      for (const nid of c.nodeIds || []) hidden.add(nid);
    }
    return hidden;
  }

  function collapsedBox(c) {
    const w = c.w != null && c.w > 0 ? c.w : 168;
    const h = c.h != null && c.h > 0 ? c.h : 72;
    return { x: c.x || 0, y: c.y || 0, w, h };
  }

  function setNodeSelection(ids, primaryId) {
    selectedNodeIds = new Set(ids || []);
    selectedNodeId = primaryId || (selectedNodeIds.size ? [...selectedNodeIds][0] : null);
    selectedCollapsedId = null;
    selectedEdgeId = null;
  }

  function clearGraphSelection() {
    selectedNodeIds = new Set();
    selectedNodeId = null;
    selectedCollapsedId = null;
    selectedEdgeId = null;
  }

  function updateExpandButton() {
    const btn = document.getElementById("btn-graph-expand");
    if (btn) btn.disabled = !selectedCollapsedId;
  }

  function findEntryNameForSelection(ids) {
    const idSet = new Set(ids);
    const entries = (doc.graph.nodes || []).filter(
      (n) =>
        idSet.has(n.id) &&
        (n.kind === "entry" || n.kind === "function") &&
        n.name != null &&
        String(n.name).trim()
    );
    if (entries.length === 1) {
      return { ok: true, name: String(entries[0].name).trim(), entryId: entries[0].id };
    }
    if (entries.length > 1) {
      return { ok: false, error: "Multiple named Function entries in selection." };
    }
    // Ancestors of selection (incoming closure)
    const edges = doc.graph.edges || [];
    const incoming = new Map();
    for (const e of edges) {
      if (!incoming.has(e.to)) incoming.set(e.to, []);
      incoming.get(e.to).push(e.from);
    }
    const ancestors = new Set();
    const stack = [...idSet];
    while (stack.length) {
      const cur = stack.pop();
      for (const fr of incoming.get(cur) || []) {
        if (ancestors.has(fr) || idSet.has(fr)) continue;
        ancestors.add(fr);
        stack.push(fr);
      }
    }
    const ancEntries = (doc.graph.nodes || []).filter(
      (n) =>
        ancestors.has(n.id) &&
        (n.kind === "entry" || n.kind === "function") &&
        n.name != null &&
        String(n.name).trim()
    );
    if (ancEntries.length === 1) {
      return { ok: true, name: String(ancEntries[0].name).trim(), entryId: ancEntries[0].id };
    }
    return {
      ok: false,
      error: "Select nodes that include one named Function entry.",
    };
  }


  function reachableClosureFromEntry(entryId) {
    const nodes = doc.graph.nodes || [];
    const edges = doc.graph.edges || [];
    const outgoing = new Map();
    const incoming = new Map();
    for (const e of edges) {
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from).push(e.to);
      if (!incoming.has(e.to)) incoming.set(e.to, []);
      incoming.get(e.to).push(e.from);
    }
    const reachable = new Set();
    const stack = [entryId];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const to of outgoing.get(id) || []) stack.push(to);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...reachable]) {
        for (const fr of incoming.get(id) || []) {
          if (!reachable.has(fr)) {
            reachable.add(fr);
            changed = true;
          }
        }
      }
    }
    return reachable;
  }

  function remapIdsForPublish(nodes, edges, collapsed) {
    const idMap = new Map();
    const newNodes = nodes.map((n) => {
      const nn = { ...n };
      const nid = uid("n");
      idMap.set(n.id, nid);
      nn.id = nid;
      return nn;
    });
    const newEdges = edges
      .filter((e) => idMap.has(e.from) && idMap.has(e.to))
      .map((e) => ({
        ...e,
        id: uid("e"),
        from: idMap.get(e.from),
        to: idMap.get(e.to),
      }));
    const newCollapsed = (collapsed || []).map((c) => ({
      ...c,
      id: uid("c"),
      nodeIds: (c.nodeIds || []).map((i) => idMap.get(i)).filter(Boolean),
    }));
    return { nodes: newNodes, edges: newEdges, collapsed: newCollapsed };
  }

  async function publishToLibrary() {
    let name = null;
    let entryId = null;
    let memberIds = null;

    if (selectedCollapsedId) {
      const block = collapsedById(selectedCollapsedId);
      if (!block) {
        setStatus("No compressed block selected", "warn");
        return;
      }
      name = block.name != null ? String(block.name).trim() : "";
      if (!name) {
        setStatus("Compressed block has no function name", "err");
        return;
      }
      memberIds = new Set(block.nodeIds || []);
      const entry =
        (doc.graph.nodes || []).find(
          (n) =>
            memberIds.has(n.id) &&
            (n.kind === "entry" || n.kind === "function") &&
            n.name != null &&
            String(n.name).trim() === name
        ) ||
        (doc.graph.nodes || []).find(
          (n) =>
            memberIds.has(n.id) &&
            (n.kind === "entry" || n.kind === "function") &&
            n.name != null &&
            String(n.name).trim()
        );
      if (!entry) {
        setStatus("Compressed block has no named Function entry", "err");
        return;
      }
      entryId = entry.id;
      name = String(entry.name).trim();
    } else {
      const ids = [...selectedNodeIds];
      if (!ids.length) {
        setStatus("Select a named Function (or compressed block) to publish", "warn");
        return;
      }
      const found = findEntryNameForSelection(ids);
      if (!found.ok) {
        setStatus(found.error, "err");
        return;
      }
      name = found.name;
      entryId = found.entryId;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setStatus('Mechanic name must match A-Za-z0-9_- (got "' + name + '")', "err");
      return;
    }

    const closure = reachableClosureFromEntry(entryId);
    if (memberIds) {
      // Optional: compressed selection — still use runtime closure so ancestors included
      for (const id of memberIds) closure.add(id);
    }
    const nodes = (doc.graph.nodes || []).filter((n) => closure.has(n.id));
    const edges = (doc.graph.edges || []).filter(
      (e) => closure.has(e.from) && closure.has(e.to)
    );
    const collapsed = ensureCollapsedArray()
      .filter((c) => (c.nodeIds || []).some((nid) => closure.has(nid)))
      .map((c) => ({
        ...c,
        nodeIds: (c.nodeIds || []).filter((nid) => closure.has(nid)),
      }));

    const remapped = remapIdsForPublish(nodes, edges, collapsed);
    const body = {
      name,
      nodes: remapped.nodes,
      edges: remapped.edges,
    };
    if (remapped.collapsed.length) body.collapsed = remapped.collapsed;

    setStatus(`Publishing mechanic "${name}"…`);
    try {
      const res = await fetch(`/api/mechanics/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `Publish failed (${res.status})`, "err");
        return;
      }
      setStatus(`Published mechanic "${name}"`, "ok");
    } catch (err) {
      setStatus(String(err), "err");
    }
  }


  function compressSelection() {
    const ids = [...selectedNodeIds];
    if (!ids.length) {
      setStatus("Select nodes to compress", "warn");
      return;
    }
    const found = findEntryNameForSelection(ids);
    if (!found.ok) {
      setStatus(found.error, "err");
      return;
    }
    const nodeIdSet = new Set(ids);
    if (found.entryId) nodeIdSet.add(found.entryId);
    const memberNodes = (doc.graph.nodes || []).filter((n) => nodeIdSet.has(n.id));
    if (!memberNodes.length) {
      setStatus("Nothing to compress", "warn");
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of memberNodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
    }
    const pad = 16;
    const w = Math.max(168, maxX - minX + pad * 2);
    const h = Math.max(72, maxY - minY + pad * 2);
    const cx = minX + (maxX - minX) / 2;
    const cy = minY + (maxY - minY) / 2;
    const block = {
      id: uid("c"),
      name: found.name,
      nodeIds: [...nodeIdSet],
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
    };
    doc.graph.collapsed = ensureCollapsedArray().filter(
      (c) => !(c.nodeIds || []).some((nid) => nodeIdSet.has(nid))
    );
    doc.graph.collapsed.push(block);
    selectedCollapsedId = block.id;
    selectedNodeIds = new Set();
    selectedNodeId = null;
    selectedEdgeId = null;
    renderGraph();
    setStatus(`Compressed “${found.name}” (${block.nodeIds.length} nodes)`, "ok");
  }

  function expandCollapsed(cid) {
    const id = cid || selectedCollapsedId;
    const block = collapsedById(id);
    if (!block) {
      setStatus("No compressed block selected", "warn");
      return;
    }
    const entry =
      (doc.graph.nodes || []).find(
        (n) =>
          (block.nodeIds || []).includes(n.id) &&
          (n.kind === "entry" || n.kind === "function") &&
          n.name != null &&
          String(n.name).trim() === String(block.name || "").trim()
      ) ||
      (doc.graph.nodes || []).find(
        (n) =>
          (block.nodeIds || []).includes(n.id) &&
          (n.kind === "entry" || n.kind === "function")
      );
    doc.graph.collapsed = ensureCollapsedArray().filter((c) => c.id !== block.id);
    if (entry) setNodeSelection([entry.id], entry.id);
    else if (block.nodeIds && block.nodeIds.length) setNodeSelection(block.nodeIds, block.nodeIds[0]);
    else clearGraphSelection();
    renderGraph();
    setStatus(`Expanded “${block.name || "block"}”`, "ok");
  }

  function deleteSelectedGraph() {
    if (selectedEdgeId) {
      doc.graph.edges = doc.graph.edges.filter((e) => e.id !== selectedEdgeId);
      selectedEdgeId = null;
      renderGraph();
      return;
    }
    if (selectedCollapsedId) {
      const block = collapsedById(selectedCollapsedId);
      if (block) {
        const kill = new Set(block.nodeIds || []);
        doc.graph.edges = doc.graph.edges.filter(
          (e) => !kill.has(e.from) && !kill.has(e.to)
        );
        doc.graph.nodes = doc.graph.nodes.filter((n) => !kill.has(n.id));
        doc.graph.collapsed = ensureCollapsedArray().filter((c) => c.id !== block.id);
        setStatus(
          `Deleted compressed “${block.name || "block"}” (${kill.size} nodes)`,
          "warn"
        );
      }
      clearGraphSelection();
      renderGraph();
      return;
    }
    const ids = selectedNodeIds.size
      ? [...selectedNodeIds]
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    if (!ids.length) return;
    const kill = new Set(ids);
    doc.graph.edges = doc.graph.edges.filter(
      (e) => !kill.has(e.from) && !kill.has(e.to)
    );
    doc.graph.nodes = doc.graph.nodes.filter((n) => !kill.has(n.id));
    doc.graph.collapsed = ensureCollapsedArray()
      .map((c) => ({
        ...c,
        nodeIds: (c.nodeIds || []).filter((nid) => !kill.has(nid)),
      }))
      .filter((c) => c.nodeIds.length > 0);
    clearGraphSelection();
    renderGraph();
  }

  function renderGraph() {
    const nodes = doc.graph.nodes || [];
    const edges = doc.graph.edges || [];
    const hidden = memberIdSet();
    let html = `<g id="graph-root" transform="translate(${graphView.x},${graphView.y}) scale(${graphView.scale})">`;
    html += `<g id="wires">`;
    for (const e of edges) {
      if (hidden.has(e.from) || hidden.has(e.to)) continue;
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) continue;
      const p0 = portPos(a, "out");
      const p1 = portPos(b, "in", e.toPort);
      const mid = (p0.x + p1.x) / 2;
      const sel = e.id === selectedEdgeId ? " wire-selected" : "";
      html += `<path class="wire${sel}" data-eid="${esc(e.id)}" d="M${p0.x},${p0.y} C${mid},${p0.y} ${mid},${p1.y} ${p1.x},${p1.y}" />`;
    }
    if (wireFrom) {
      const a = nodeById(wireFrom.nodeId);
      if (a && !hidden.has(a.id)) {
        const p0 = portPos(a, "out");
        const p1 = { x: wireFrom.x, y: wireFrom.y };
        const mid = (p0.x + p1.x) / 2;
        html += `<path class="wire wire-temp" d="M${p0.x},${p0.y} C${mid},${p0.y} ${mid},${p1.y} ${p1.x},${p1.y}" />`;
      }
    }
    html += `</g><g id="nodes">`;
    for (const n of nodes) {
      if (hidden.has(n.id)) continue;
      const sel = selectedNodeIds.has(n.id) || n.id === selectedNodeId ? " node-selected" : "";
      html += `<g class="node${sel}" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})">`;
      html += `<rect class="node-rect" width="${NODE_W}" height="${NODE_H}" />`;
      html += `<text class="node-title" x="12" y="22">${esc(nodeLabel(n))}</text>`;
      html += `<text class="node-sub" x="12" y="38">${esc(nodeSub(n))}</text>`;
      if (hasOutputPort(n)) {
        html += `<circle class="port" data-port="out" data-id="${esc(n.id)}" cx="${NODE_W}" cy="${NODE_H / 2}" r="6" />`;
      }
      const ar = arityOf(n);
      for (let i = 0; i < ar; i++) {
        const pp = portPos({ x: 0, y: 0, kind: n.kind, op: n.op, role: n.role }, "in", i);
        html += `<circle class="port port-in" data-port="in" data-port-index="${i}" data-id="${esc(n.id)}" cx="0" cy="${pp.y}" r="6" />`;
      }
      html += `</g>`;
    }
    html += `</g><g id="collapsed">`;
    for (const c of ensureCollapsedArray()) {
      const box = collapsedBox(c);
      const sel = c.id === selectedCollapsedId ? " collapsed-selected" : "";
      html += `<g class="collapsed-block${sel}" data-cid="${esc(c.id)}" transform="translate(${box.x},${box.y})">`;
      html += `<rect class="collapsed-rect" width="${box.w}" height="${box.h}" />`;
      html += `<text class="collapsed-title" x="14" y="28">${esc(c.name || "(unnamed)")}</text>`;
      html += `<text class="collapsed-sub" x="14" y="46">function · compressed · ${(c.nodeIds || []).length} nodes</text>`;
      html += `</g>`;
    }
    html += `</g></g>`;
    graphSvg.innerHTML = html;
    renderGraphProps();
    updateExpandButton();
  }

  function hitNode(x, y) {
    const nodes = doc.graph.nodes || [];
    const hidden = memberIdSet();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (hidden.has(n.id)) continue;
      if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n;
    }
    return null;
  }

  function hitCollapsed(x, y) {
    const list = ensureCollapsedArray();
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const box = collapsedBox(c);
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return c;
    }
    return null;
  }

  function hitPort(x, y) {
    const nodes = doc.graph.nodes || [];
    const hidden = memberIdSet();
    const R = 10;
    for (const n of nodes) {
      if (hidden.has(n.id)) continue;
      if (hasOutputPort(n)) {
        const p = portPos(n, "out");
        if ((x - p.x) * (x - p.x) + (y - p.y) * (y - p.y) <= R * R) {
          return { nodeId: n.id, port: "out", index: 0 };
        }
      }
      const ar = arityOf(n);
      for (let i = 0; i < ar; i++) {
        const p = portPos(n, "in", i);
        if ((x - p.x) * (x - p.x) + (y - p.y) * (y - p.y) <= R * R) {
          return { nodeId: n.id, port: "in", index: i };
        }
      }
    }
    return null;
  }

  function hitEdge(x, y) {
    const edges = doc.graph.edges || [];
    const hidden = memberIdSet();
    for (const e of edges) {
      if (hidden.has(e.from) || hidden.has(e.to)) continue;
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) continue;
      const p0 = portPos(a, "out");
      const p1 = portPos(b, "in", e.toPort);
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      if ((x - mx) * (x - mx) + (y - my) * (y - my) < 14 * 14) return e;
    }
    return null;
  }

  function renderGraphProps() {
    const compiled = compileGraph(doc.graph);
    if (selectedCollapsedId) {
      const c = collapsedById(selectedCollapsedId);
      let msg = c
        ? `<span class="hint">Compressed “${esc(c.name || "")}” · ${(c.nodeIds || []).length} nodes · double-click or Expand</span>`
        : `<span class="hint">Compressed block</span>`;
      if (compiled.error) {
        msg += ` <span class="formula-preview" style="color:var(--err)">${esc(compiled.error)}</span>`;
      }
      graphProps.innerHTML = msg;
      return;
    }
    if (selectedNodeIds.size > 1) {
      let msg = `<span class="hint">${selectedNodeIds.size} nodes selected · Compress to group · Shift/Ctrl-click to toggle</span>`;
      if (compiled.error) {
        msg += ` <span class="formula-preview" style="color:var(--err)">${esc(compiled.error)}</span>`;
      }
      graphProps.innerHTML = msg;
      return;
    }
    const n = selectedNodeId ? nodeById(selectedNodeId) : null;
    if (!n) {
      let msg = `<span class="hint">Drag palette onto canvas · wire ports · wheel zoom · mid/space/empty pan · Shift-click multi-select</span>`;
      if (compiled.error) {
        msg += ` <span class="formula-preview" style="color:var(--err)">${esc(compiled.error)}</span>`;
      } else if (Object.keys(compiled.formulas).length) {
        msg +=
          " " +
          Object.entries(compiled.formulas)
            .map(([k, v]) => `<span class="formula-preview">${esc(k)}: ${esc(v)}</span>`)
            .join(" ");
      }
      graphProps.innerHTML = msg;
      return;
    }
    let body = "";
    if (n.kind === "field") {
      body += `<label>Field <input type="text" id="g-field" value="${esc(n.field || "")}" placeholder="FIELD_ID" style="width:8rem" /></label>`;
      body += `<label>Role <select id="g-role">
        <option value="source"${n.role !== "output" ? " selected" : ""}>source</option>
        <option value="output"${n.role === "output" ? " selected" : ""}>output (formula sink)</option>
      </select></label>`;
    } else if (n.kind === "const") {
      body += `<label>Value <input type="number" id="g-const" value="${esc(String(n.value))}" style="width:5rem" /></label>`;
    } else if (n.kind === "op") {
      const op = n.op;
      let portHint = "";
      if (op === "if") portHint = " · ports: cond, then, else";
      else if (op === "not" || op === "floor") portHint = " · port: a";
      else if (
        op === "and" ||
        op === "or" ||
        op === "+" ||
        op === "-" ||
        op === "*" ||
        op === "/" ||
        op === "==" ||
        op === "!=" ||
        op === "<" ||
        op === ">" ||
        op === "<=" ||
        op === ">="
      )
        portHint = " · ports: a, b";
      body += `<span class="hint">Op: ${esc(op)}${portHint}</span>`;
    } else if (n.kind === "roll") {
      body += `<label>Sides <input type="number" id="g-sides" min="2" value="${esc(String(n.sides != null ? n.sides : 20))}" style="width:4rem" /></label>`;
      body += `<span class="hint">runtime roll 1..sides</span>`;
    } else if (n.kind === "entry" || n.kind === "function") {
      body += `<label>Name <input type="text" id="g-entry-name" value="${esc(n.name || "")}" placeholder="function_id" style="width:8rem" /></label>`;
      body += `<span class="hint">button function_id entry point</span>`;
    } else if (n.kind === "send_to_chat" || n.kind === "chat") {
      body += `<label>Label <input type="text" id="g-chat-label" value="${esc(n.label || "")}" placeholder="optional" style="width:8rem" /></label>`;
      const arithOn = n.include_arithmetic === true;
      body += `<label><input type="checkbox" id="g-chat-arith"${arithOn ? " checked" : ""} /> Send arithmetic to chat</label>`;
      body += `<span class="hint">terminal · publishes input to session chat</span>`;
    }
    if (n.kind === "field" && n.role === "output" && !compiled.error && compiled.formulas[n.field]) {
      body += `<span class="formula-preview">${esc(n.field)} ← ${esc(compiled.formulas[n.field])}</span>`;
    } else if (compiled.error) {
      body += `<span class="formula-preview" style="color:var(--err)">${esc(compiled.error)}</span>`;
    }
    graphProps.innerHTML = body;

    const gf = document.getElementById("g-field");
    const gr = document.getElementById("g-role");
    const gc = document.getElementById("g-const");
    const gs = document.getElementById("g-sides");
    const ge = document.getElementById("g-entry-name");
    const gchat = document.getElementById("g-chat-label");
    const garith = document.getElementById("g-chat-arith");
    if (gf) {
      gf.addEventListener("change", () => {
        const id = gf.value.trim();
        if (id && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
          setStatus("Invalid field id", "err");
          return;
        }
        n.field = id;
        if (id) ensureField(id);
        renderGraph();
      });
    }
    if (gr) {
      gr.addEventListener("change", () => {
        n.role = gr.value;
        renderGraph();
      });
    }
    if (gc) {
      gc.addEventListener("change", () => {
        n.value = Number(gc.value);
        renderGraph();
      });
    }
    if (gs) {
      gs.addEventListener("change", () => {
        n.sides = Math.max(2, Math.floor(Number(gs.value) || 20));
        gs.value = String(n.sides);
        renderGraph();
      });
    }
    if (ge) {
      ge.addEventListener("change", () => {
        n.name = ge.value.trim();
        renderGraph();
      });
    }
    if (gchat) {
      gchat.addEventListener("change", () => {
        n.label = gchat.value.trim();
        renderGraph();
      });
    }
    if (garith) {
      garith.addEventListener("change", () => {
        n.include_arithmetic = !!garith.checked;
        renderGraph();
      });
    }
  }

  function addGraphNode(kind, op, x, y) {
    const n = {
      id: uid("n"),
      kind,
      x: x - NODE_W / 2,
      y: y - NODE_H / 2,
    };
    if (kind === "field") {
      n.field = "";
      n.role = "source";
    } else if (kind === "const") {
      n.value = 0;
    } else if (kind === "op") {
      n.op = op || "+";
    } else if (kind === "roll") {
      n.sides = 20;
    } else if (kind === "entry" || kind === "function") {
      n.kind = "entry";
      n.name = "";
    } else if (kind === "send_to_chat" || kind === "chat") {
      n.kind = "send_to_chat";
      n.label = "";
      n.include_arithmetic = false;
    }
    doc.graph.nodes.push(n);
    setNodeSelection([n.id], n.id);
    renderGraph();
  }

  document.querySelectorAll("#graph-palette [data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-kind");
      const op = btn.getAttribute("data-op");
      const wrap = document.getElementById("graph-wrap");
      const rect = wrap.getBoundingClientRect();
      const sx = rect.width / 2;
      const sy = rect.height / 2;
      const wx = (sx - graphView.x) / graphView.scale;
      const wy = (sy - graphView.y) / graphView.scale;
      addGraphNode(kind, op, wx, wy);
    });
  });

  document.getElementById("btn-graph-delete").addEventListener("click", () => {
    deleteSelectedGraph();
  });

  const btnGraphCompress = document.getElementById("btn-graph-compress");
  if (btnGraphCompress) {
    btnGraphCompress.addEventListener("click", () => compressSelection());
  }
  const btnGraphExpand = document.getElementById("btn-graph-expand");
  if (btnGraphExpand) {
    btnGraphExpand.addEventListener("click", () => expandCollapsed());
  }
  const btnGraphPublish = document.getElementById("btn-graph-publish");
  if (btnGraphPublish) {
    btnGraphPublish.addEventListener("click", () => {
      publishToLibrary().catch((err) => setStatus(String(err), "err"));
    });
  }

  graphSvg.addEventListener("pointerdown", (e) => {
    const p = graphWorldPoint(e);
    const port = hitPort(p.x, p.y);
    const hitCollapsedBlock = !port ? hitCollapsed(p.x, p.y) : null;
    const hit = !port && !hitCollapsedBlock ? hitNode(p.x, p.y) : null;
    const edge = !port && !hit && !hitCollapsedBlock ? hitEdge(p.x, p.y) : null;
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;

    const wantPan =
      e.button === 1 ||
      (e.button === 0 && spaceDown) ||
      (e.button === 0 &&
        graphTool === "select" &&
        !port &&
        !hit &&
        !hitCollapsedBlock &&
        !edge &&
        !wireFrom);

    if (wantPan && !wireFrom) {
      e.preventDefault();
      graphPan = {
        sx: e.clientX,
        sy: e.clientY,
        vx: graphView.x,
        vy: graphView.y,
      };
      graphSvg.setPointerCapture(e.pointerId);
      clearGraphSelection();
      renderGraph();
      return;
    }

    if (port && port.port === "out") {
      wireFrom = { nodeId: port.nodeId, x: p.x, y: p.y };
      setNodeSelection([port.nodeId], port.nodeId);
      graphSvg.setPointerCapture(e.pointerId);
      renderGraph();
      return;
    }
    if (port && port.port === "in" && wireFrom) {
      finishWire(port.nodeId, port.index);
      return;
    }
    if (wireFrom && port && port.port === "in") {
      finishWire(port.nodeId, port.index);
      return;
    }
    if (edge && !port) {
      selectedEdgeId = edge.id;
      selectedNodeIds = new Set();
      selectedNodeId = null;
      selectedCollapsedId = null;
      renderGraph();
      return;
    }
    if (hitCollapsedBlock) {
      selectedCollapsedId = hitCollapsedBlock.id;
      selectedNodeIds = new Set();
      selectedNodeId = null;
      selectedEdgeId = null;
      const box = collapsedBox(hitCollapsedBlock);
      graphDrag = {
        kind: "collapsed",
        id: hitCollapsedBlock.id,
        ox: p.x - box.x,
        oy: p.y - box.y,
        origins: Object.fromEntries(
          (hitCollapsedBlock.nodeIds || []).map((nid) => {
            const n = nodeById(nid);
            return [nid, n ? { x: n.x, y: n.y } : { x: 0, y: 0 }];
          })
        ),
        startX: box.x,
        startY: box.y,
      };
      graphSvg.setPointerCapture(e.pointerId);
      renderGraph();
      return;
    }
    if (hit) {
      if (multi) {
        if (selectedNodeIds.has(hit.id)) selectedNodeIds.delete(hit.id);
        else selectedNodeIds.add(hit.id);
        selectedNodeId = selectedNodeIds.has(hit.id)
          ? hit.id
          : selectedNodeIds.size
            ? [...selectedNodeIds][0]
            : null;
        selectedCollapsedId = null;
        selectedEdgeId = null;
      } else {
        if (!selectedNodeIds.has(hit.id) || selectedNodeIds.size <= 1) {
          setNodeSelection([hit.id], hit.id);
        } else {
          // keep multi-selection; make hit primary
          selectedNodeId = hit.id;
          selectedCollapsedId = null;
          selectedEdgeId = null;
        }
      }
      const dragIds = selectedNodeIds.size ? [...selectedNodeIds] : [hit.id];
      graphDrag = {
        kind: "nodes",
        ids: dragIds,
        origins: Object.fromEntries(
          dragIds.map((nid) => {
            const n = nodeById(nid);
            return [nid, n ? { x: n.x, y: n.y } : { x: 0, y: 0 }];
          })
        ),
        anchorX: p.x,
        anchorY: p.y,
      };
      graphSvg.setPointerCapture(e.pointerId);
      renderGraph();
      return;
    }
    clearGraphSelection();
    if (graphTool === "select" && !wireFrom) {
      graphPan = {
        sx: e.clientX,
        sy: e.clientY,
        vx: graphView.x,
        vy: graphView.y,
      };
      graphSvg.setPointerCapture(e.pointerId);
    }
    renderGraph();
  });

  function finishWire(toId, toPort) {
    if (!wireFrom) return;
    if (wireFrom.nodeId === toId) {
      wireFrom = null;
      renderGraph();
      return;
    }
    // Replace existing edge into same port
    doc.graph.edges = doc.graph.edges.filter(
      (e) => !(e.to === toId && (e.toPort == null ? 0 : e.toPort) === toPort)
    );
    doc.graph.edges.push({
      id: uid("e"),
      from: wireFrom.nodeId,
      to: toId,
      toPort: toPort,
    });
    wireFrom = null;
    renderGraph();
    const compiled = compileGraph(doc.graph);
    if (compiled.error) setStatus(compiled.error, "err");
    else setStatus("Wired", "ok");
  }

  graphSvg.addEventListener("pointermove", (e) => {
    if (graphPan) {
      const ctm = graphSvg.getScreenCTM();
      const a = ctm && ctm.a ? ctm.a : 1;
      const d = ctm && ctm.d ? ctm.d : 1;
      setGraphView({
        scale: graphView.scale,
        x: graphPan.vx + (e.clientX - graphPan.sx) / a,
        y: graphPan.vy + (e.clientY - graphPan.sy) / d,
      });
      return;
    }
    const p = graphWorldPoint(e);
    if (wireFrom) {
      wireFrom.x = p.x;
      wireFrom.y = p.y;
      renderGraph();
      return;
    }
    if (!graphDrag) return;
    if (graphDrag.kind === "collapsed") {
      const block = collapsedById(graphDrag.id);
      if (!block) return;
      const nx = p.x - graphDrag.ox;
      const ny = p.y - graphDrag.oy;
      const dx = nx - graphDrag.startX;
      const dy = ny - graphDrag.startY;
      block.x = nx;
      block.y = ny;
      for (const nid of block.nodeIds || []) {
        const n = nodeById(nid);
        const o = graphDrag.origins[nid];
        if (n && o) {
          n.x = o.x + dx;
          n.y = o.y + dy;
        }
      }
      renderGraph();
      return;
    }
    if (graphDrag.kind === "nodes") {
      const dx = p.x - graphDrag.anchorX;
      const dy = p.y - graphDrag.anchorY;
      for (const nid of graphDrag.ids || []) {
        const n = nodeById(nid);
        const o = graphDrag.origins[nid];
        if (n && o) {
          n.x = o.x + dx;
          n.y = o.y + dy;
        }
      }
      renderGraph();
      return;
    }
    // legacy single-node drag
    const n = nodeById(graphDrag.id);
    if (!n) return;
    n.x = p.x - graphDrag.ox;
    n.y = p.y - graphDrag.oy;
    renderGraph();
  });

  graphSvg.addEventListener("pointerup", (e) => {
    if (wireFrom) {
      const p = graphWorldPoint(e);
      const port = hitPort(p.x, p.y);
      if (port && port.port === "in") {
        finishWire(port.nodeId, port.index);
        graphPan = null;
        return;
      }
      wireFrom = null;
      renderGraph();
    }
    graphDrag = null;
    graphPan = null;
  });
  graphSvg.addEventListener("pointercancel", () => {
    graphDrag = null;
    graphPan = null;
    wireFrom = null;
  });

  graphSvg.addEventListener("dblclick", (e) => {
    const p = graphWorldPoint(e);
    const c = hitCollapsed(p.x, p.y);
    if (c) {
      e.preventDefault();
      expandCollapsed(c.id);
    }
  });

  graphSvg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const screen = svgPoint(graphSvg, e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomGraphAt(screen.x, screen.y, factor);
    },
    { passive: false }
  );

  const btnGraphZoomIn = document.getElementById("btn-graph-zoom-in");
  const btnGraphZoomOut = document.getElementById("btn-graph-zoom-out");
  const btnGraphZoomReset = document.getElementById("btn-graph-zoom-reset");
  if (btnGraphZoomIn) {
    btnGraphZoomIn.addEventListener("click", () => {
      const wrap = document.getElementById("graph-wrap");
      const rect = wrap.getBoundingClientRect();
      zoomGraphAt(rect.width / 2, rect.height / 2, 1.2);
    });
  }
  if (btnGraphZoomOut) {
    btnGraphZoomOut.addEventListener("click", () => {
      const wrap = document.getElementById("graph-wrap");
      const rect = wrap.getBoundingClientRect();
      zoomGraphAt(rect.width / 2, rect.height / 2, 1 / 1.2);
    });
  }
  if (btnGraphZoomReset) {
    btnGraphZoomReset.addEventListener("click", () => {
      setGraphView({ scale: 1, x: 0, y: 0 });
    });
  }

  const btnGraphSelect = document.getElementById("btn-graph-select");
  if (btnGraphSelect) {
    btnGraphSelect.addEventListener("click", () => {
      graphTool = "select";
      btnGraphSelect.classList.add("active");
    });
  }

  // --- Render all / boot ---
  function renderAll() {
    renderDisplay();
    renderGraph();
  }

  async function refreshSheetList(selectId) {
    try {
      const data = await listSheets();
      const sheets = data.sheets || [];
      sheetSelect.innerHTML = sheets
        .map(
          (s) =>
            `<option value="${esc(s.id)}">${esc(s.id)}${s.has_builder ? " *" : ""}</option>`
        )
        .join("");
      if (!sheets.length) {
        sheetSelect.innerHTML = `<option value="player">player</option>`;
      }
      if (selectId) sheetSelect.value = selectId;
    } catch (err) {
      sheetSelect.innerHTML = `<option value="player">player</option><option value="npc">npc</option>`;
      if (selectId) sheetSelect.value = selectId;
    }
  }

  sheetSelect.addEventListener("change", () => {
    loadBuilder(sheetSelect.value).catch((err) => setStatus(String(err), "err"));
  });
  btnSave.addEventListener("click", () => {
    saveBuilder().catch((err) => setStatus(String(err), "err"));
  });
  btnCompile.addEventListener("click", () => {
    compileBuilder().catch((err) => setStatus(String(err), "err"));
  });
  btnReload.addEventListener("click", () => {
    loadBuilder(sheetSelect.value || doc.sheet_id).catch((err) =>
      setStatus(String(err), "err")
    );
  });

  async function boot() {
    const id = qsSheetId();
    await refreshSheetList(id);
    await loadBuilder(id);
  }

  boot().catch((err) => {
    console.error(err);
    setStatus(String(err), "err");
    seedStrModGraph();
    renderAll();
  });
})();
