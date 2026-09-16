(() => {
  "use strict";

  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const viewport = document.getElementById("viewport");
  const layout = document.getElementById("layout");
  const nameEl = document.getElementById("scene-name");
  const metaEl = document.getElementById("scene-meta");
  const statusEl = document.getElementById("status");
  const actorListEl = document.getElementById("actor-list");
  const sceneListEl = document.getElementById("scene-list");
  const layerListEl = document.getElementById("layer-list");
  const toggleGridEl = document.getElementById("toggle-grid");
  const toggleSnapEl = document.getElementById("toggle-snap");
  const btnAddLayer = document.getElementById("btn-add-layer");
  const layerFileInput = document.getElementById("layer-file");

  const params = new URLSearchParams(location.search);
  let sceneId = params.get("scene") || "docks";

  /** @type {any} */
  let scene = null;
  /** @type {Map<string, HTMLImageElement>} hash -> Image */
  const imageCache = new Map();
  /** @type {{id: string, name: string, asset: string, visible: boolean, x: number, y: number, w?: number, h?: number, img: HTMLImageElement|null}[]} */
  let mapLayers = [];
  /** @type {any[]} */
  let tokens = [];
  /** @type {any|null} */
  let library = null;
  let selectedActorId = null;
  let currentSheetActorId = null;

  let extent = { x: 0, y: 0, w: 1400, h: 1400 };
  let gridSize = 70;

  let showGrid = true;
  let snapToGrid = true;
  let uiSaveTimer = null;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let saveTimer = null;

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function initials(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function snapWorld(x, y) {
    const g = gridSize;
    return [
      Math.floor(x / g) * g + g / 2,
      Math.floor(y / g) * g + g / 2,
    ];
  }

  function maybeSnap(x, y) {
    if (!snapToGrid) return [x, y];
    return snapWorld(x, y);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = viewport.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function collectPoints(sc) {
    const pts = [];
    for (const w of sc.walls || []) {
      pts.push([w.x1, w.y1], [w.x2, w.y2]);
    }
    for (const d of sc.doors || []) {
      pts.push([d.x1, d.y1], [d.x2, d.y2]);
    }
    for (const L of sc.lights || []) {
      const r = Number(L.radius) || 0;
      pts.push([L.x - r, L.y - r], [L.x + r, L.y + r]);
    }
    for (const s of sc.spawns || []) {
      pts.push([s.x, s.y]);
    }
    for (const t of tokens) {
      pts.push([t.x, t.y]);
    }
    for (const layer of mapLayers) {
      const lx = Number(layer.x) || 0;
      const ly = Number(layer.y) || 0;
      if (layer.w != null && layer.h != null) {
        pts.push([lx, ly], [lx + layer.w, ly + layer.h]);
      } else if (layer.img && layer.img.naturalWidth > 0) {
        pts.push(
          [lx, ly],
          [lx + layer.img.naturalWidth, ly + layer.img.naturalHeight]
        );
      }
    }
    return pts;
  }

  function primaryMapImage() {
    for (const layer of mapLayers) {
      if (layer.img && layer.img.naturalWidth > 0) return layer.img;
    }
    return null;
  }

  function computeExtent(sc) {
    const g = (sc.grid && sc.grid.size) || 70;
    gridSize = g;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const pts = collectPoints(sc);
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const img = primaryMapImage();
    if (img && img.naturalWidth > 0) {
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const geomW = Number.isFinite(maxX - minX) ? maxX - minX : 0;
      const geomH = Number.isFinite(maxY - minY) ? maxY - minY : 0;
      if (iw >= geomW * 0.5 && ih >= geomH * 0.5 && (iw > g || ih > g)) {
        return { x: 0, y: 0, w: iw, h: ih };
      }
    }

    if (!Number.isFinite(minX)) {
      return { x: 0, y: 0, w: 20 * g, h: 20 * g };
    }

    const pad = g;
    minX = Math.min(0, minX) - pad;
    minY = Math.min(0, minY) - pad;
    maxX = maxX + pad;
    maxY = maxY + pad;

    const left = Math.floor(minX / g) * g;
    const top = Math.floor(minY / g) * g;
    const right = Math.ceil(maxX / g) * g;
    const bottom = Math.ceil(maxY / g) * g;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function fitToView() {
    const rect = viewport.getBoundingClientRect();
    const margin = 24;
    const sx = (rect.width - margin * 2) / extent.w;
    const sy = (rect.height - margin * 2) / extent.h;
    scale = Math.max(0.05, Math.min(sx, sy));
    offsetX =
      margin +
      (rect.width - margin * 2 - extent.w * scale) / 2 -
      extent.x * scale;
    offsetY =
      margin +
      (rect.height - margin * 2 - extent.h * scale) / 2 -
      extent.y * scale;
  }

  function worldToScreen(x, y) {
    return [x * scale + offsetX, y * scale + offsetY];
  }

  function screenToWorld(sx, sy) {
    return [(sx - offsetX) / scale, (sy - offsetY) / scale];
  }

  // --- Layer 1: map images ---
  function drawMapImages() {
    const pts = collectPoints(scene);
    let maxX = 0;
    let maxY = 0;
    for (const [x, y] of pts) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    for (const layer of mapLayers) {
      if (!layer.visible) continue;
      const img = layer.img;
      if (!img || !img.complete || img.naturalWidth === 0) continue;
      const lx = Number(layer.x) || 0;
      const ly = Number(layer.y) || 0;
      let dw = layer.w != null ? Number(layer.w) : img.naturalWidth;
      let dh = layer.h != null ? Number(layer.h) : img.naturalHeight;
      // Tiny placeholder stretch (same logic as legacy background)
      if (layer.w == null && layer.h == null) {
        if (dw < maxX * 0.5 || dh < maxY * 0.5) {
          dw = Math.max(maxX, gridSize);
          dh = Math.max(maxY, gridSize);
        }
      }
      const [sx, sy] = worldToScreen(lx, ly);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, sx, sy, dw * scale, dh * scale);
      ctx.restore();
    }
  }

  // Map geometry (with map, before grid)
  function drawWalls() {
    ctx.save();
    ctx.strokeStyle = "#e8eefc";
    ctx.lineWidth = Math.max(2, 3 * Math.min(scale, 2));
    ctx.lineCap = "round";
    for (const w of scene.walls || []) {
      const [x1, y1] = worldToScreen(w.x1, w.y1);
      const [x2, y2] = worldToScreen(w.x2, w.y2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDoors() {
    ctx.save();
    ctx.lineCap = "round";
    for (const d of scene.doors || []) {
      const [x1, y1] = worldToScreen(d.x1, d.y1);
      const [x2, y2] = worldToScreen(d.x2, d.y2);
      const open = !!d.open;
      const locked = !!d.locked;
      ctx.strokeStyle = locked ? "#ff6b6b" : open ? "#7ddea5" : "#f0c14a";
      ctx.lineWidth = Math.max(2, 4 * Math.min(scale, 2));
      ctx.setLineDash(open ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(3, 4 * Math.min(scale, 1.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawLights() {
    ctx.save();
    for (const L of scene.lights || []) {
      const [cx, cy] = worldToScreen(L.x, L.y);
      const r = (Number(L.radius) || 0) * scale;
      const bright = (Number(L.bright) || 0) * scale;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 1));
      grad.addColorStop(0, "rgba(255, 220, 120, 0.55)");
      grad.addColorStop(
        bright > 0 ? Math.min(0.85, bright / Math.max(r, 1)) : 0.4,
        "rgba(255, 180, 60, 0.22)"
      );
      grad.addColorStop(1, "rgba(255, 160, 40, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(r, 4), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, 3 * Math.min(scale, 1.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSpawns() {
    ctx.save();
    ctx.font = `${Math.max(11, 12 * Math.min(scale, 1.4))}px system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    for (const s of scene.spawns || []) {
      const [cx, cy] = worldToScreen(s.x, s.y);
      const r = Math.max(5, 7 * Math.min(scale, 1.5));
      ctx.fillStyle = "#6ea8fe";
      ctx.strokeStyle = "#dbe7ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const label = s.label || s.id || "spawn";
      ctx.fillStyle = "#e8ecf4";
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 3;
      ctx.strokeText(label, cx + r + 4, cy - 2);
      ctx.fillText(label, cx + r + 4, cy - 2);
    }
    ctx.restore();
  }

  // --- Layer 2: grid overlay ---
  function drawGrid() {
    if (!showGrid) return;
    const g = gridSize;
    const startCol = Math.floor(extent.x / g);
    const endCol = Math.ceil((extent.x + extent.w) / g);
    const startRow = Math.floor(extent.y / g);
    const endRow = Math.ceil((extent.y + extent.h) / g);

    ctx.save();
    // Brighter / thicker so grid stays visible on map images
    ctx.strokeStyle = "rgba(220, 230, 250, 0.55)";
    ctx.lineWidth = Math.max(1.25, 1.5 * Math.min(scale, 1.5));

    for (let c = startCol; c <= endCol; c++) {
      const x = c * g;
      const [sx1, sy1] = worldToScreen(x, extent.y);
      const [, sy2] = worldToScreen(x, extent.y + extent.h);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx1, sy2);
      ctx.stroke();
    }
    for (let r = startRow; r <= endRow; r++) {
      const y = r * g;
      const [sx1, sy1] = worldToScreen(extent.x, y);
      const [sx2] = worldToScreen(extent.x + extent.w, y);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy1);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(240, 245, 255, 0.85)";
    ctx.lineWidth = 2.5;
    const [bx, by] = worldToScreen(extent.x, extent.y);
    ctx.strokeRect(bx, by, extent.w * scale, extent.h * scale);
    ctx.restore();
  }

  // --- Layer 3: tokens ---
  function drawTokens() {
    ctx.save();
    for (const t of tokens) {
      const [cx, cy] = worldToScreen(t.x, t.y);
      const r = Math.max(10, gridSize * 0.35 * Math.min(scale, 2));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "rgba(20, 24, 36, 0.85)";
      ctx.lineWidth = Math.max(1.5, 2 * Math.min(scale, 1.5));
      ctx.stroke();

      const label = t.label || initials(t.name);
      ctx.fillStyle = "#1a1f2c";
      ctx.font = `bold ${Math.max(10, r * 0.7)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy);

      ctx.font = `${Math.max(10, 11 * Math.min(scale, 1.3))}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = "#e8ecf4";
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.lineWidth = 3;
      ctx.strokeText(t.name || "", cx, cy + r + 3);
      ctx.fillText(t.name || "", cx, cy + r + 3);
    }
    ctx.restore();
  }

  // --- Layer 4: additions stub ---
  function drawOverlayAdditions() {
    // Stub for future drawings / effects. Intentionally empty for now.
  }

  /**
   * Fixed draw order (YAML layer types do not control z-order):
   * 1 map images → map geometry (walls/doors/lights/spawns) →
   * 2 grid (if on) → 3 tokens → 4 overlay additions stub
   */
  function draw() {
    const rect = viewport.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!scene) return;

    drawMapImages();
    drawWalls();
    drawDoors();
    drawLights();
    drawSpawns();
    drawGrid();
    drawTokens();
    drawOverlayAdditions();
  }

  function loadImageByHash(hash) {
    return new Promise((resolve) => {
      if (!hash) {
        resolve(null);
        return;
      }
      if (imageCache.has(hash)) {
        resolve(imageCache.get(hash));
        return;
      }
      const img = new Image();
      img.onload = () => {
        imageCache.set(hash, img);
        resolve(img);
      };
      img.onerror = () => {
        setStatus(`Map asset missing: ${hash.slice(0, 12)}…`);
        resolve(null);
      };
      img.src = `/assets/${hash}`;
    });
  }

  function resolveMapLayerDefs(sc) {
    const layers = Array.isArray(sc.layers) ? sc.layers : [];
    const mapDefs = layers.filter((l) => l && l.type === "map" && l.asset);
    if (mapDefs.length) {
      return mapDefs.map((l, i) => ({
        id: l.id || `map-${i}`,
        name: l.name || l.id || `Map layer ${i + 1}`,
        asset: String(l.asset),
        visible: l.visible !== false,
        x: Number(l.x) || 0,
        y: Number(l.y) || 0,
        w: l.w != null ? Number(l.w) : undefined,
        h: l.h != null ? Number(l.h) : undefined,
      }));
    }
    // Legacy: scene.background counts as bottom map layer
    if (sc.background) {
      return [
        {
          id: "background",
          name: "Base map",
          asset: String(sc.background),
          visible: true,
          x: 0,
          y: 0,
        },
      ];
    }
    return [];
  }

  async function loadMapLayers(sc) {
    const defs = resolveMapLayerDefs(sc);
    const loaded = [];
    for (const def of defs) {
      const img = await loadImageByHash(def.asset);
      loaded.push({ ...def, img });
    }
    mapLayers = loaded;
  }

  function getSceneLayersForWrite() {
    // Preserve non-map layers from scene YAML; rewrite map layers from mapLayers state
    const existing = Array.isArray(scene.layers) ? scene.layers.slice() : [];
    const nonMap = existing.filter((l) => l && l.type !== "map");
    const mapEntries = mapLayers.map((l) => {
      const entry = {
        id: l.id,
        type: "map",
        name: l.name,
        asset: l.asset,
        visible: !!l.visible,
      };
      if (l.x) entry.x = l.x;
      if (l.y) entry.y = l.y;
      if (l.w != null) entry.w = l.w;
      if (l.h != null) entry.h = l.h;
      return entry;
    });
    // Map layers first (list order = bottom→top for images), then other typed layers
    return [...mapEntries, ...nonMap];
  }

  async function persistSceneLayers() {
    const layers = getSceneLayersForWrite();
    try {
      const res = await fetch(`/api/scene/${encodeURIComponent(sceneId)}/layers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layers }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(`Layer save failed (${res.status}): ${err.error || ""}`);
        return false;
      }
      const data = await res.json();
      if (scene) scene.layers = data.layers || layers;
      return true;
    } catch (err) {
      setStatus(`Layer save error: ${err}`);
      return false;
    }
  }

  function renderMapLayersList() {
    layerListEl.innerHTML = "";
    if (!mapLayers.length) {
      const empty = document.createElement("div");
      empty.className = "scene-item";
      empty.style.cursor = "default";
      empty.textContent = "No map layers";
      layerListEl.appendChild(empty);
      return;
    }
    for (const layer of mapLayers) {
      const item = document.createElement("div");
      item.className = "layer-item";
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = `eye ${layer.visible ? "on" : "off"}`;
      eye.title = layer.visible ? "Hide layer" : "Show layer";
      eye.textContent = layer.visible ? "👁" : "◌";
      eye.addEventListener("click", async () => {
        layer.visible = !layer.visible;
        renderMapLayersList();
        draw();
        await persistSceneLayers();
      });
      const name = document.createElement("span");
      name.className = `lname${layer.visible ? "" : " dim"}`;
      name.textContent = layer.name;
      name.title = `${layer.name} (${layer.asset.slice(0, 12)}…)`;
      item.appendChild(eye);
      item.appendChild(name);
      layerListEl.appendChild(item);
    }
  }

  async function loadTokens() {
    const res = await fetch(`/api/tokens/${encodeURIComponent(sceneId)}`);
    if (!res.ok) {
      tokens = [];
      return;
    }
    const data = await res.json();
    tokens = Array.isArray(data.tokens) ? data.tokens : [];
  }

  async function persistTokens() {
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(sceneId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: sceneId, tokens }),
      });
      if (!res.ok) {
        setStatus(`Token save failed (${res.status})`);
        return;
      }
      setStatus(`${tokens.length} token(s) · saved to state/tokens/${sceneId}.json`);
    } catch (err) {
      setStatus(`Token save error: ${err}`);
    }
  }

  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistTokens();
    }, 200);
  }

  async function loadUiPrefs() {
    try {
      const res = await fetch(`/api/ui/${encodeURIComponent(sceneId)}`);
      if (res.ok) {
        const data = await res.json();
        showGrid = data.showGrid !== false;
        snapToGrid = data.snapToGrid !== false;
      }
    } catch (_) {
      // defaults already ON
    }
    toggleGridEl.checked = showGrid;
    toggleSnapEl.checked = snapToGrid;
  }

  async function persistUiPrefs() {
    try {
      await fetch(`/api/ui/${encodeURIComponent(sceneId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showGrid,
          snapToGrid,
        }),
      });
    } catch (_) {
      // best-effort; also mirror to localStorage as fallback
    }
    try {
      localStorage.setItem(
        `vtt-ui:${sceneId}`,
        JSON.stringify({ showGrid, snapToGrid })
      );
    } catch (_) {}
  }

  function scheduleUiPersist() {
    if (uiSaveTimer) clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(() => {
      persistUiPrefs();
    }, 150);
  }

  function placeToken(actor, worldX, worldY) {
    const [x, y] = maybeSnap(worldX, worldY);
    const name = actor.name || actor.id;
    tokens.push({
      id: `${actor.id}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      actor_id: actor.id,
      name,
      label: initials(name),
      x,
      y,
    });
    draw();
    schedulePersist();
  }

  async function loadScene(id, { fit = true } = {}) {
    sceneId = id;
    const url = new URL(location.href);
    url.searchParams.set("scene", sceneId);
    history.replaceState(null, "", url);

    setStatus(`Loading scene “${sceneId}”…`);
    const res = await fetch(`/api/scene/${encodeURIComponent(sceneId)}`);
    if (!res.ok) {
      nameEl.textContent = "Scene not found";
      setStatus(`Failed to load /api/scene/${sceneId} (${res.status})`);
      return;
    }
    scene = await res.json();
    nameEl.textContent = scene.name || scene.id || sceneId;
    const g = scene.grid || {};
    metaEl.textContent = `grid ${g.size || "?"}px · ${g.type || "square"} · ${g.units || ""}`.trim();

    await loadUiPrefs();
    await loadMapLayers(scene);
    await loadTokens();
    extent = computeExtent(scene);
    if (fit) fitToView();
    const visibleMaps = mapLayers.filter((l) => l.visible && l.img).length;
    setStatus(
      `${Math.round(extent.w / gridSize)}×${Math.round(extent.h / gridSize)} tiles` +
        (visibleMaps ? ` · ${visibleMaps} map layer(s)` : "") +
        ` · ${tokens.length} token(s)`
    );
    renderLibrarySelection();
    renderMapLayersList();
    draw();
  }

  function renderLibrarySelection() {
    for (const el of sceneListEl.querySelectorAll(".scene-item")) {
      el.classList.toggle("active", el.dataset.id === sceneId);
    }
    for (const el of actorListEl.querySelectorAll(".lib-item")) {
      el.classList.toggle("active", el.dataset.id === selectedActorId);
    }
  }

  function openSheet(actorId) {
    selectedActorId = actorId;
    currentSheetActorId = actorId;
    renderLibrarySelection();

    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.open_sheet === "function"
        ? window.pywebview.api
        : null;

    if (api) {
      Promise.resolve(api.open_sheet(actorId))
        .then(() => setStatus(`Sheet opened: ${actorId}`))
        .catch((err) =>
          setStatus(`Could not open sheet: ${err && err.message ? err.message : err}`)
        );
      return;
    }

    setStatus(
      "Character sheets need the GM Session desktop app (pywebview). Run desktop_app.py — browser serve.py cannot open sheet windows."
    );
  }

  function renderLibrary() {
    actorListEl.innerHTML = "";
    sceneListEl.innerHTML = "";
    if (!library) return;

    for (const actor of library.actors || []) {
      const item = document.createElement("div");
      item.className = "lib-item";
      item.draggable = true;
      item.dataset.id = actor.id;
      item.title = "Drag onto map to place token · Click to open sheet in a pop-out";
      item.innerHTML = `
        <span class="dot" aria-hidden="true"></span>
        <span class="name">
          <strong></strong>
          <span></span>
        </span>
      `;
      item.querySelector("strong").textContent = actor.name || actor.id;
      item.querySelector(".name span").textContent = actor.sheet
        ? `sheet: ${actor.sheet}`
        : "actor";
      if (actor.has_sheet) {
        const flag = document.createElement("span");
        flag.className = "sheet-flag";
        flag.textContent = "sheet";
        item.appendChild(flag);
      }
      item.addEventListener("click", () => {
        openSheet(actor.id);
      });
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(
          "application/x-vtt-actor",
          JSON.stringify(actor)
        );
        e.dataTransfer.setData("text/plain", actor.id);
        e.dataTransfer.effectAllowed = "copy";
      });
      actorListEl.appendChild(item);
    }

    for (const sc of library.scenes || []) {
      const item = document.createElement("div");
      item.className = "scene-item";
      item.dataset.id = sc.id;
      item.textContent = sc.name || sc.id;
      item.addEventListener("click", () => {
        loadScene(sc.id).catch((err) => setStatus(String(err)));
      });
      sceneListEl.appendChild(item);
    }
    renderLibrarySelection();
  }

  async function loadLibrary() {
    const res = await fetch("/api/library");
    if (!res.ok) {
      setStatus(`Library load failed (${res.status})`);
      return;
    }
    library = await res.json();
    renderLibrary();
  }

  async function addMapLayerFromFile(file) {
    if (!file) return;
    setStatus(`Uploading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Asset-Name": `maps/${file.name}`,
        },
        body: buf,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(`Upload failed (${res.status}): ${err.error || ""}`);
        return;
      }
      const { hash, name } = await res.json();
      const baseId = String(file.name || "layer")
        .replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "layer";
      let id = baseId;
      let n = 2;
      const used = new Set(mapLayers.map((l) => l.id));
      while (used.has(id)) {
        id = `${baseId}-${n++}`;
      }
      const img = await loadImageByHash(hash);
      mapLayers.push({
        id,
        name: file.name.replace(/\.[^.]+$/, "") || name || id,
        asset: hash,
        visible: true,
        x: 0,
        y: 0,
        img,
      });
      // Ensure scene has layers key including legacy upgrade
      if (!scene.layers) scene.layers = [];
      const ok = await persistSceneLayers();
      if (!ok) return;
      extent = computeExtent(scene);
      renderMapLayersList();
      draw();
      setStatus(`Added map layer “${id}” (${hash.slice(0, 12)}…)`);
    } catch (err) {
      setStatus(`Upload error: ${err}`);
    }
  }

  btnAddLayer.addEventListener("click", () => {
    layerFileInput.value = "";
    layerFileInput.click();
  });
  layerFileInput.addEventListener("change", () => {
    const file = layerFileInput.files && layerFileInput.files[0];
    if (file) addMapLayerFromFile(file);
  });

  toggleGridEl.addEventListener("change", () => {
    showGrid = !!toggleGridEl.checked;
    draw();
    scheduleUiPersist();
  });
  toggleSnapEl.addEventListener("change", () => {
    snapToGrid = !!toggleSnapEl.checked;
    scheduleUiPersist();
  });

  function canvasLocal(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function tokenRadiusScreen() {
    return Math.max(10, gridSize * 0.35 * Math.min(scale, 2));
  }

  /** Topmost token under screen point, or null. Tokens sit above map pan. */
  function hitTestToken(sx, sy) {
    const r = tokenRadiusScreen();
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      const [cx, cy] = worldToScreen(t.x, t.y);
      const dx = sx - cx;
      const dy = sy - cy;
      if (dx * dx + dy * dy <= r * r) return t;
    }
    return null;
  }

  /** @type {"none"|"pan"|"token"} */
  let dragMode = "none";
  /** @type {any|null} */
  let draggingToken = null;

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const [sx, sy] = canvasLocal(e);
    const hit = hitTestToken(sx, sy);
    lastX = e.clientX;
    lastY = e.clientY;
    if (hit) {
      dragMode = "token";
      draggingToken = hit;
      dragging = false;
      viewport.classList.remove("dragging");
      viewport.style.cursor = "grabbing";
    } else {
      dragMode = "pan";
      draggingToken = null;
      dragging = true;
      viewport.classList.add("dragging");
    }
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (dragMode === "none") {
      const [sx, sy] = canvasLocal(e);
      viewport.style.cursor = hitTestToken(sx, sy) ? "move" : "grab";
      return;
    }
    if (dragMode === "token" && draggingToken) {
      const [sx, sy] = canvasLocal(e);
      const [wx, wy] = screenToWorld(sx, sy);
      const [nx, ny] = maybeSnap(wx, wy);
      draggingToken.x = nx;
      draggingToken.y = ny;
      draw();
      return;
    }
    if (dragMode === "pan" && dragging) {
      offsetX += e.clientX - lastX;
      offsetY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      draw();
    }
  });
  function endDrag(e) {
    if (dragMode === "token" && draggingToken) {
      schedulePersist();
    }
    dragMode = "none";
    draggingToken = null;
    dragging = false;
    viewport.classList.remove("dragging");
    viewport.style.cursor = "grab";
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - offsetX) / scale;
      const worldY = (my - offsetY) / scale;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(8, Math.max(0.05, scale * factor));
      offsetX = mx - worldX * next;
      offsetY = my - worldY * next;
      scale = next;
      draw();
    },
    { passive: false }
  );

  viewport.addEventListener("dblclick", () => {
    fitToView();
    draw();
  });

  viewport.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    viewport.classList.add("drop-target");
  });
  viewport.addEventListener("dragleave", () => {
    viewport.classList.remove("drop-target");
  });
  viewport.addEventListener("drop", (e) => {
    e.preventDefault();
    viewport.classList.remove("drop-target");
    let actor = null;
    const raw = e.dataTransfer.getData("application/x-vtt-actor");
    if (raw) {
      try {
        actor = JSON.parse(raw);
      } catch (_) {}
    }
    if (!actor) {
      const id = e.dataTransfer.getData("text/plain");
      actor = (library?.actors || []).find((a) => a.id === id) || null;
    }
    if (!actor) return;
    const rect = canvas.getBoundingClientRect();
    const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    placeToken(actor, wx, wy);
  });

  window.addEventListener("resize", resize);

  async function boot() {
    layout.classList.add("no-sheet");
    resize();
    await loadLibrary();
    await loadScene(sceneId);
  }

  boot().catch((err) => {
    console.error(err);
    setStatus(String(err));
  });
})();
