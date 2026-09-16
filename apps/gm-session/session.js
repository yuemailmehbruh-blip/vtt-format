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
  const toggleSnapLayersEl = document.getElementById("toggle-snap-layers");
  const btnAddLayer = document.getElementById("btn-add-layer");
  const layerFileInput = document.getElementById("layer-file");
  const btnUpdate = document.getElementById("btn-update");
  const updateStatusEl = document.getElementById("update-status");

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
  let snapLayers = false;
  /** @type {"aspect"|"h"|"v"} */
  let layerResizeMode = "aspect";
  /** @type {string|null} */
  let editingLayerId = null;
  let uiSaveTimer = null;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let saveTimer = null;

  const HANDLE_HALF = 5;
  const HANDLE_NAMES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setUpdateStatus(msg) {
    if (updateStatusEl) updateStatusEl.textContent = msg || "";
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

  function snapLayerOnRelease(layer) {
    if (!snapLayers || !layer) return;
    const g = gridSize;
    layer.x = Math.round((Number(layer.x) || 0) / g) * g;
    layer.y = Math.round((Number(layer.y) || 0) / g) * g;
    if (layer.w != null) {
      layer.w = Math.max(g, Math.round(Number(layer.w) / g) * g);
    }
    if (layer.h != null) {
      layer.h = Math.max(g, Math.round(Number(layer.h) / g) * g);
    }
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
    // Extent from map layers + tokens only (walls/doors/lights/spawns unused in play view)
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

  function layerDrawSize(layer, maxX, maxY) {
    const img = layer.img;
    let dw = layer.w != null ? Number(layer.w) : img ? img.naturalWidth : 0;
    let dh = layer.h != null ? Number(layer.h) : img ? img.naturalHeight : 0;
    if (layer.w == null && layer.h == null && img) {
      if (dw < maxX * 0.5 || dh < maxY * 0.5) {
        dw = Math.max(maxX, gridSize);
        dh = Math.max(maxY, gridSize);
      }
    }
    return [dw, dh];
  }

  function ensureLayerSize(layer) {
    if (layer.w != null && layer.h != null) return;
    const img = layer.img;
    if (img && img.naturalWidth > 0) {
      if (layer.w == null) layer.w = img.naturalWidth;
      if (layer.h == null) layer.h = img.naturalHeight;
    } else {
      if (layer.w == null) layer.w = gridSize * 10;
      if (layer.h == null) layer.h = gridSize * 10;
    }
  }

  function layerWorldRect(layer) {
    ensureLayerSize(layer);
    return {
      x: Number(layer.x) || 0,
      y: Number(layer.y) || 0,
      w: Math.max(1, Number(layer.w) || 1),
      h: Math.max(1, Number(layer.h) || 1),
    };
  }

  function getLayerHandleScreen(layer) {
    const r = layerWorldRect(layer);
    const [sx, sy] = worldToScreen(r.x, r.y);
    const sw = r.w * scale;
    const sh = r.h * scale;
    return {
      nw: [sx, sy],
      n: [sx + sw / 2, sy],
      ne: [sx + sw, sy],
      e: [sx + sw, sy + sh / 2],
      se: [sx + sw, sy + sh],
      s: [sx + sw / 2, sy + sh],
      sw: [sx, sy + sh],
      w: [sx, sy + sh / 2],
      rect: { sx, sy, sw, sh },
      world: r,
    };
  }

  function editingLayer() {
    if (!editingLayerId) return null;
    return mapLayers.find((l) => l.id === editingLayerId) || null;
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
      const [dw, dh] = layerDrawSize(layer, maxX, maxY);
      const [sx, sy] = worldToScreen(lx, ly);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, sx, sy, dw * scale, dh * scale);
      ctx.restore();
    }
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

  /** Selection rect + resize handles — edit UI after world stack. */
  function drawLayerEditChrome() {
    const layer = editingLayer();
    if (!layer || !layer.visible) return;
    const hs = getLayerHandleScreen(layer);
    const { sx, sy, sw, sh } = hs.rect;
    ctx.save();
    ctx.strokeStyle = "#6ea8fe";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);
    const size = HANDLE_HALF * 2;
    for (const name of HANDLE_NAMES) {
      const [hx, hy] = hs[name];
      ctx.fillStyle = "#1b2030";
      ctx.strokeStyle = "#6ea8fe";
      ctx.lineWidth = 1.5;
      ctx.fillRect(hx - HANDLE_HALF, hy - HANDLE_HALF, size, size);
      ctx.strokeRect(hx - HANDLE_HALF, hy - HANDLE_HALF, size, size);
    }
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
   * 1 map images → 2 grid (if on) → 3 tokens → 4 overlay additions stub →
   * 5 layer edit chrome (selection/handles; edit UI only)
   */
  function draw() {
    const rect = viewport.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!scene) return;

    drawMapImages();
    drawGrid();
    drawTokens();
    drawOverlayAdditions();
    drawLayerEditChrome();
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
        x: Number(l.x) || 0,
        y: Number(l.y) || 0,
      };
      if (l.w != null) entry.w = Number(l.w);
      if (l.h != null) entry.h = Number(l.h);
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

  function setEditingLayer(id) {
    editingLayerId = id;
    if (id) {
      const layer = mapLayers.find((l) => l.id === id);
      if (layer) ensureLayerSize(layer);
    }
    renderMapLayersList();
    draw();
  }

  function moveLayer(index, dir) {
    const j = index + dir;
    if (j < 0 || j >= mapLayers.length) return;
    const tmp = mapLayers[index];
    mapLayers[index] = mapLayers[j];
    mapLayers[j] = tmp;
    renderMapLayersList();
    draw();
    persistSceneLayers();
  }

  async function deleteLayer(layer) {
    if (!confirm(`Delete map layer “${layer.name || layer.id}”?`)) return;
    mapLayers = mapLayers.filter((l) => l.id !== layer.id);
    if (editingLayerId === layer.id) editingLayerId = null;
    renderMapLayersList();
    draw();
    await persistSceneLayers();
    setStatus(`Deleted layer “${layer.id}”`);
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
    // UI list is reversed: top of list = topmost drawn (end of array)
    for (let index = mapLayers.length - 1; index >= 0; index--) {
      const layer = mapLayers[index];
      const item = document.createElement("div");
      item.className = `layer-item${editingLayerId === layer.id ? " editing" : ""}`;

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

      const btns = document.createElement("div");
      btns.className = "layer-btns";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = `icon-btn${editingLayerId === layer.id ? " on" : ""}`;
      editBtn.title = editingLayerId === layer.id ? "Stop editing" : "Edit layer (move/resize)";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => {
        setEditingLayer(editingLayerId === layer.id ? null : layer.id);
      });

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "icon-btn";
      upBtn.title = "↑ Bring forward (higher z / top of list)";
      upBtn.textContent = "↑";
      upBtn.disabled = index >= mapLayers.length - 1;
      upBtn.addEventListener("click", () => moveLayer(index, 1));

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "icon-btn";
      downBtn.title = "↓ Send back (lower z / bottom of list)";
      downBtn.textContent = "↓";
      downBtn.disabled = index <= 0;
      downBtn.addEventListener("click", () => moveLayer(index, -1));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn danger";
      delBtn.title = "Delete layer";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => {
        deleteLayer(layer);
      });

      btns.appendChild(editBtn);
      btns.appendChild(upBtn);
      btns.appendChild(downBtn);
      btns.appendChild(delBtn);

      item.appendChild(eye);
      item.appendChild(name);
      item.appendChild(btns);
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
        snapLayers = !!data.snapLayers;
      }
    } catch (_) {
      // defaults already ON for grid/snap; snapLayers off
    }
    toggleGridEl.checked = showGrid;
    toggleSnapEl.checked = snapToGrid;
    if (toggleSnapLayersEl) toggleSnapLayersEl.checked = snapLayers;
  }

  async function persistUiPrefs() {
    try {
      await fetch(`/api/ui/${encodeURIComponent(sceneId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showGrid,
          snapToGrid,
          snapLayers,
        }),
      });
    } catch (_) {
      // best-effort; also mirror to localStorage as fallback
    }
    try {
      localStorage.setItem(
        `vtt-ui:${sceneId}`,
        JSON.stringify({ showGrid, snapToGrid, snapLayers })
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

    editingLayerId = null;
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
  if (toggleSnapLayersEl) {
    toggleSnapLayersEl.addEventListener("change", () => {
      snapLayers = !!toggleSnapLayersEl.checked;
      scheduleUiPersist();
    });
  }

  for (const radio of document.querySelectorAll('input[name="layer-resize-mode"]')) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      layerResizeMode = /** @type {"aspect"|"h"|"v"} */ (radio.value);
      for (const lab of document.querySelectorAll("#layer-resize-modes label")) {
        const inp = lab.querySelector("input");
        lab.classList.toggle("active", !!(inp && inp.checked));
      }
    });
  }

  async function runUpdateCheck() {
    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.check_update === "function"
        ? window.pywebview.api
        : null;

    if (!api) {
      setUpdateStatus("Update app needs the desktop app");
      setStatus(
        "Update app needs the GM Session desktop app (pywebview). Browser serve.py has no updater API."
      );
      return;
    }

    if (btnUpdate) btnUpdate.disabled = true;
    setUpdateStatus("Checking for app updates…");
    try {
      const msg = await Promise.resolve(api.check_update());
      setUpdateStatus(String(msg || "Done"));
      setStatus(String(msg || "Update app done"));
    } catch (err) {
      const text = err && err.message ? err.message : String(err);
      setUpdateStatus(`Failed: ${text}`);
      setStatus(`Update app failed: ${text}`);
    } finally {
      if (btnUpdate) btnUpdate.disabled = false;
    }
  }

  if (btnUpdate) {
    btnUpdate.addEventListener("click", () => {
      runUpdateCheck();
    });
  }

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

  function hitTestResizeHandle(sx, sy) {
    const layer = editingLayer();
    if (!layer || !layer.visible) return null;
    const hs = getLayerHandleScreen(layer);
    for (const name of HANDLE_NAMES) {
      const [hx, hy] = hs[name];
      if (Math.abs(sx - hx) <= HANDLE_HALF + 1 && Math.abs(sy - hy) <= HANDLE_HALF + 1) {
        return { layer, handle: name };
      }
    }
    return null;
  }

  function hitTestEditingLayerBody(sx, sy) {
    const layer = editingLayer();
    if (!layer || !layer.visible) return null;
    const hs = getLayerHandleScreen(layer);
    const { sx: rx, sy: ry, sw, sh } = hs.rect;
    if (sx >= rx && sx <= rx + sw && sy >= ry && sy <= ry + sh) return layer;
    return null;
  }

  function cursorForHandle(handle) {
    const map = {
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
    };
    return map[handle] || "move";
  }

  /**
   * Apply resize from pointer world position given drag origin snapshot.
   * Modes: aspect (uniform on corners), h (width only), v (height only).
   */
  function applyLayerResize(layer, handle, wx, wy, origin) {
    const minSize = 8;
    let x = origin.lx;
    let y = origin.ly;
    let w = origin.lw;
    let h = origin.lh;
    const right = origin.lx + origin.lw;
    const bottom = origin.ly + origin.lh;
    const mode = layerResizeMode;
    const isCorner = handle.length === 2;
    const aspect = origin.lw / Math.max(origin.lh, 1e-6);

    const affectW = mode !== "v";
    const affectH = mode !== "h";

    if (handle.includes("e")) {
      if (affectW) w = Math.max(minSize, wx - origin.lx);
    }
    if (handle.includes("w")) {
      if (affectW) {
        const newX = Math.min(wx, right - minSize);
        w = right - newX;
        x = newX;
      }
    }
    if (handle.includes("s")) {
      if (affectH) h = Math.max(minSize, wy - origin.ly);
    }
    if (handle.includes("n")) {
      if (affectH) {
        const newY = Math.min(wy, bottom - minSize);
        h = bottom - newY;
        y = newY;
      }
    }

    // Aspect: uniform scale on corner drags (default)
    if (mode === "aspect" && isCorner) {
      const useW = Math.abs(w - origin.lw) >= Math.abs(h - origin.lh);
      if (useW) {
        h = Math.max(minSize, w / aspect);
      } else {
        w = Math.max(minSize, h * aspect);
      }
      // Re-anchor opposite corner
      if (handle.includes("w")) x = right - w;
      else x = origin.lx;
      if (handle.includes("n")) y = bottom - h;
      else y = origin.ly;
    }

    // H only: lock height (corners & edges)
    if (mode === "h") {
      h = origin.lh;
      y = origin.ly;
    }
    // V only: lock width
    if (mode === "v") {
      w = origin.lw;
      x = origin.lx;
    }

    layer.x = x;
    layer.y = y;
    layer.w = w;
    layer.h = h;
  }

  /** @type {"none"|"pan"|"token"|"layer-move"|"layer-resize"} */
  let dragMode = "none";
  /** @type {any|null} */
  let draggingToken = null;
  /** @type {any|null} */
  let draggingLayer = null;
  /** @type {string|null} */
  let resizeHandle = null;
  /** @type {{lx:number,ly:number,lw:number,lh:number,ox:number,oy:number}|null} */
  let layerDragOrigin = null;

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const [sx, sy] = canvasLocal(e);
    lastX = e.clientX;
    lastY = e.clientY;

    // 1) Editing layer: handles, then body
    const handleHit = hitTestResizeHandle(sx, sy);
    if (handleHit) {
      dragMode = "layer-resize";
      draggingLayer = handleHit.layer;
      resizeHandle = handleHit.handle;
      ensureLayerSize(draggingLayer);
      const r = layerWorldRect(draggingLayer);
      const [wx, wy] = screenToWorld(sx, sy);
      layerDragOrigin = {
        lx: r.x,
        ly: r.y,
        lw: r.w,
        lh: r.h,
        ox: wx,
        oy: wy,
      };
      dragging = false;
      viewport.classList.remove("dragging");
      viewport.style.cursor = cursorForHandle(handleHit.handle);
      viewport.setPointerCapture(e.pointerId);
      return;
    }

    const layerBody = hitTestEditingLayerBody(sx, sy);
    if (layerBody) {
      dragMode = "layer-move";
      draggingLayer = layerBody;
      resizeHandle = null;
      ensureLayerSize(layerBody);
      const r = layerWorldRect(layerBody);
      const [wx, wy] = screenToWorld(sx, sy);
      layerDragOrigin = {
        lx: r.x,
        ly: r.y,
        lw: r.w,
        lh: r.h,
        ox: wx,
        oy: wy,
      };
      dragging = false;
      viewport.classList.remove("dragging");
      viewport.style.cursor = "move";
      viewport.setPointerCapture(e.pointerId);
      return;
    }

    // 2) Tokens
    const hit = hitTestToken(sx, sy);
    if (hit) {
      dragMode = "token";
      draggingToken = hit;
      draggingLayer = null;
      dragging = false;
      viewport.classList.remove("dragging");
      viewport.style.cursor = "grabbing";
      viewport.setPointerCapture(e.pointerId);
      return;
    }

    // 3) Pan
    dragMode = "pan";
    draggingToken = null;
    draggingLayer = null;
    dragging = true;
    viewport.classList.add("dragging");
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener("pointermove", (e) => {
    if (dragMode === "none") {
      const [sx, sy] = canvasLocal(e);
      const handleHit = hitTestResizeHandle(sx, sy);
      if (handleHit) {
        viewport.style.cursor = cursorForHandle(handleHit.handle);
        return;
      }
      if (hitTestEditingLayerBody(sx, sy)) {
        viewport.style.cursor = "move";
        return;
      }
      viewport.style.cursor = hitTestToken(sx, sy) ? "move" : "grab";
      return;
    }

    if (dragMode === "token" && draggingToken) {
      // Free movement while dragging — snap only on pointerup
      const [sx, sy] = canvasLocal(e);
      const [wx, wy] = screenToWorld(sx, sy);
      draggingToken.x = wx;
      draggingToken.y = wy;
      draw();
      return;
    }

    if (dragMode === "layer-move" && draggingLayer && layerDragOrigin) {
      const [sx, sy] = canvasLocal(e);
      const [wx, wy] = screenToWorld(sx, sy);
      const dx = wx - layerDragOrigin.ox;
      const dy = wy - layerDragOrigin.oy;
      draggingLayer.x = layerDragOrigin.lx + dx;
      draggingLayer.y = layerDragOrigin.ly + dy;
      draw();
      return;
    }

    if (dragMode === "layer-resize" && draggingLayer && layerDragOrigin && resizeHandle) {
      const [sx, sy] = canvasLocal(e);
      const [wx, wy] = screenToWorld(sx, sy);
      applyLayerResize(draggingLayer, resizeHandle, wx, wy, layerDragOrigin);
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
      if (snapToGrid) {
        const [nx, ny] = snapWorld(draggingToken.x, draggingToken.y);
        draggingToken.x = nx;
        draggingToken.y = ny;
        draw();
      }
      schedulePersist();
    }
    if (
      (dragMode === "layer-move" || dragMode === "layer-resize") &&
      draggingLayer
    ) {
      snapLayerOnRelease(draggingLayer);
      draw();
      persistSceneLayers();
      extent = computeExtent(scene);
    }
    dragMode = "none";
    draggingToken = null;
    draggingLayer = null;
    resizeHandle = null;
    layerDragOrigin = null;
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
