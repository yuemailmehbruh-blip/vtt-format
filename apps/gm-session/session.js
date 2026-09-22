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
  const toggleNametagsEl = document.getElementById("toggle-nametags");
  const toggleSnapLayersEl = document.getElementById("toggle-snap-layers");
  const snapTargetEl = document.getElementById("snap-target");
  const toggleGridFitEl = document.getElementById("toggle-grid-fit");
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
  /** @type {string|null} */
  let selectedTokenId = null;
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerMoved = false;

  let extent = { x: 0, y: 0, w: 1400, h: 1400 };
  let gridSize = 70;

  let showGrid = true;
  let snapToGrid = true;
  /** @type {"center"|"corner"} */
  let snapTarget = "center";
  let showNametags = true;
  let snapLayers = false;
  /** Resize handles always use aspect on corners; edges stretch one axis. */
  const layerResizeMode = "aspect";
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
    if (snapTarget === "corner") {
      return [Math.round(x / g) * g, Math.round(y / g) * g];
    }
    return [
      Math.floor(x / g) * g + g / 2,
      Math.floor(y / g) * g + g / 2,
    ];
  }

  function syncSnapTargetUi() {
    if (!snapTargetEl) return;
    const mode = snapTarget === "corner" ? "corner" : "center";
    snapTarget = mode;
    snapTargetEl.querySelectorAll("button[data-snap-target]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-snap-target") === mode);
    });
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

  function layerFlipX(layer) {
    return !!layer.flipX;
  }
  function layerFlipY(layer) {
    return !!layer.flipY;
  }
  function layerRotation(layer) {
    const r = Number(layer.rotation) || 0;
    return ((r % 360) + 360) % 360;
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
      const sw = dw * scale;
      const sh = dh * scale;
      const rot = layerRotation(layer);
      const fx = layerFlipX(layer);
      const fy = layerFlipY(layer);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      if (rot || fx || fy) {
        // AABB is layer.w×h; after 90/270 the content box is the swapped size.
        const odd = rot === 90 || rot === 270;
        const cw = (odd ? sh : sw);
        const ch = (odd ? sw : sh);
        ctx.translate(sx + sw / 2, sy + sh / 2);
        if (rot) ctx.rotate((rot * Math.PI) / 180);
        ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
        ctx.drawImage(img, -cw / 2, -ch / 2, cw, ch);
      } else {
        ctx.drawImage(img, sx, sy, sw, sh);
      }
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
  function tokenSizeTiles(t) {
    const n = Number(t && t.size_tiles);
    return n > 0 ? n : 1;
  }

  /** World-space radius from diameter in tiles. */
  function tokenRadiusWorld(t) {
    return (tokenSizeTiles(t) * gridSize) / 2;
  }

  function tokenRadiusScreen(t) {
    return tokenRadiusWorld(t) * scale;
  }

  function drawTokens() {
    ctx.save();
    for (const t of tokens) {
      const [cx, cy] = worldToScreen(t.x, t.y);
      const r = tokenRadiusScreen(t);
      const selected = selectedTokenId && t.id === selectedTokenId;

      if (selected) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + Math.max(3, 4 * Math.min(scale, 1.5)), 0, Math.PI * 2);
        ctx.strokeStyle = "#6ea8fe";
        ctx.lineWidth = Math.max(2.5, 3.5 * Math.min(scale, 1.5));
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = selected ? "#6ea8fe" : "rgba(20, 24, 36, 0.85)";
      ctx.lineWidth = Math.max(1.5, 2 * Math.min(scale, 1.5));
      ctx.stroke();

      const label = t.label || initials(t.name);
      ctx.fillStyle = "#1a1f2c";
      ctx.font = `bold ${Math.max(10, r * 0.7)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy);

      if (showNametags) {
        ctx.font = `${Math.max(10, 11 * Math.min(scale, 1.3))}px system-ui, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = "#e8ecf4";
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 3;
        ctx.strokeText(t.name || "", cx, cy + r + 3);
        ctx.fillText(t.name || "", cx, cy + r + 3);
      }
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
        flipX: !!l.flipX,
        flipY: !!l.flipY,
        rotation: ((Number(l.rotation) || 0) % 360 + 360) % 360,
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
      if (l.flipX) entry.flipX = true;
      if (l.flipY) entry.flipY = true;
      const rot = ((Number(l.rotation) || 0) % 360 + 360) % 360;
      if (rot) entry.rotation = rot;
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

  function layerTileSize(layer) {
    ensureLayerSize(layer);
    const w = Number(layer.w);
    const h = Number(layer.h);
    if (!(w > 0) || !(h > 0) || !(gridSize > 0)) return null;
    const tw = Math.round((w / gridSize) * 10) / 10;
    const th = Math.round((h / gridSize) * 10) / 10;
    return { w: tw, h: th };
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

      const meta = document.createElement("div");
      meta.className = "lmeta";
      const name = document.createElement("span");
      name.className = `lname${layer.visible ? "" : " dim"}`;
      name.textContent = layer.name;
      name.title = `${layer.name} (${layer.asset.slice(0, 12)}…)`;
      const sizeEl = document.createElement("span");
      sizeEl.className = "lsize";
      const tiles = layerTileSize(layer);
      sizeEl.textContent = tiles
        ? `${tiles.w}×${tiles.h} tiles`
        : "size unknown";
      meta.appendChild(name);
      meta.appendChild(sizeEl);

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
      item.appendChild(meta);
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
    for (const t of tokens) {
      const n = Number(t.size_tiles);
      t.size_tiles = n > 0 ? n : 1;
    }
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
        showNametags = data.showNametags !== false;
        snapLayers = !!data.snapLayers;
        if (data.snapTarget === "corner" || data.snapTarget === "center") {
          snapTarget = data.snapTarget;
        }
      }
    } catch (_) {
      // defaults already ON for grid/snap/nametags; snapLayers off; snapTarget center
    }
    toggleGridEl.checked = showGrid;
    toggleSnapEl.checked = snapToGrid;
    if (toggleNametagsEl) toggleNametagsEl.checked = showNametags;
    if (toggleSnapLayersEl) toggleSnapLayersEl.checked = snapLayers;
    syncSnapTargetUi();
  }

  async function persistUiPrefs() {
    try {
      await fetch(`/api/ui/${encodeURIComponent(sceneId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showGrid,
          snapToGrid,
          snapTarget,
          showNametags,
          snapLayers,
        }),
      });
    } catch (_) {
      // best-effort; also mirror to localStorage as fallback
    }
    try {
      localStorage.setItem(
        `vtt-ui:${sceneId}`,
        JSON.stringify({ showGrid, snapToGrid, snapTarget, showNametags, snapLayers })
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
    let size = Number(
      actor.size_tiles ??
        (actor.appearance && actor.appearance.size_tiles)
    );
    if (!(size > 0)) size = 1;
    tokens.push({
      id: `${actor.id}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      actor_id: actor.id,
      name,
      label: initials(name),
      x,
      y,
      size_tiles: size,
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
    selectedTokenId = null;
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


  // --- Grid-fit on map import (image already contains a drawn grid) ---

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to decode image"));
      };
      img.src = url;
    });
  }

  function grayAt(data, w, x, y) {
    const i = (y * w + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }

  function smooth1d(arr, radius) {
    const n = arr.length;
    const out = new Float64Array(n);
    const r = Math.max(1, radius | 0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let j = i - r; j <= i + r; j++) {
        if (j < 0 || j >= n) continue;
        s += arr[j];
        c++;
      }
      out[i] = c ? s / c : 0;
    }
    return out;
  }

  /**
   * Project bright/dark thin lines. Vertical lines → score per x; horizontal → per y.
   * Optional `roi` limits accumulation (stage-2 center search). Outside ROI stays 0.
   * Full-image mode also zeros the outer 1% frame.
   */
  function lineProjections(imgData, w, h, roi) {
    const d = imgData.data;
    const vBright = new Float64Array(w);
    const vDark = new Float64Array(w);
    const hBright = new Float64Array(h);
    const hDark = new Float64Array(h);
    const x0 = Math.max(2, roi && roi.x0 != null ? roi.x0 | 0 : 2);
    const y0 = Math.max(2, roi && roi.y0 != null ? roi.y0 | 0 : 2);
    const x1 = Math.min(w - 2, roi && roi.x1 != null ? roi.x1 | 0 : w - 2);
    const y1 = Math.min(h - 2, roi && roi.y1 != null ? roi.y1 | 0 : h - 2);
    if (x1 - x0 < 8 || y1 - y0 < 8) {
      return { vBright, vDark, hBright, hDark };
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const g = grayAt(d, w, x, y);
        const nX = 0.5 * (grayAt(d, w, x - 1, y) + grayAt(d, w, x + 1, y));
        const nY = 0.5 * (grayAt(d, w, x, y - 1) + grayAt(d, w, x, y + 1));
        vBright[x] += Math.max(0, g - nX);
        vDark[x] += Math.max(0, nX - g);
        hBright[y] += Math.max(0, g - nY);
        hDark[y] += Math.max(0, nY - g);
      }
    }
    if (!roi) {
      const mx = Math.max(4, Math.floor(w * 0.01));
      const my = Math.max(4, Math.floor(h * 0.01));
      for (const arr of [vBright, vDark]) {
        for (let x = 0; x < mx; x++) arr[x] = 0;
        for (let x = w - mx; x < w; x++) arr[x] = 0;
      }
      for (const arr of [hBright, hDark]) {
        for (let y = 0; y < my; y++) arr[y] = 0;
        for (let y = h - my; y < h; y++) arr[y] = 0;
      }
    }
    return {
      vBright: smooth1d(vBright, 1),
      vDark: smooth1d(vDark, 1),
      hBright: smooth1d(hBright, 1),
      hDark: smooth1d(hDark, 1),
    };
  }

  function sample1d(signal, x) {
    const n = signal.length;
    if (!(x >= 0) || x >= n - 1) return 0;
    const i = Math.floor(x);
    const f = x - i;
    return (1 - f) * signal[i] + f * signal[i + 1];
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((p, q) => p - q);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }

  function centerRoi(w, h, frac) {
    const sideX = Math.max(16, Math.floor(w * frac));
    const sideY = Math.max(16, Math.floor(h * frac));
    const x0 = Math.floor((w - sideX) / 2);
    const y0 = Math.floor((h - sideY) / 2);
    return { x0, y0, x1: x0 + sideX, y1: y0 + sideY };
  }

  /**
   * Four consecutive comb lines around center = three cells.
   * `peakMed` / `threshFrac`: 0.5.4 used 1.2 / 0.35; 0.5.5 loosened to 1.08 / 0.22.
   */
  function axisHasThreeCells(signal, pitch, phase, center, peakMed, threshFrac, minLines) {
    if (!(pitch > 0) || signal.length < 8) return false;
    const k = Math.round((center - phase) / pitch - 1.5);
    const xs = [0, 1, 2, 3].map((i) => phase + (k + i) * pitch);
    if (xs.some((x) => x < 1 || x > signal.length - 2)) return false;
    const lo = Math.max(0, Math.floor(xs[0]));
    const hi = Math.min(signal.length - 1, Math.ceil(xs[3]));
    const slice = [];
    for (let i = lo; i <= hi; i++) slice.push(signal[i]);
    const med = medianOf(slice);
    const strengths = xs.map((x) => sample1d(signal, x));
    const peak = Math.max(...strengths);
    const pm = peakMed == null ? 1.08 : peakMed;
    const tf = threshFrac == null ? 0.22 : threshFrac;
    const need = minLines == null ? 4 : minLines;
    if (!(peak > 0) || !(peak > med * pm)) return false;
    const thresh = med + tf * (peak - med);
    let hits = 0;
    for (const s of strengths) if (s >= thresh) hits++;
    return hits >= need;
  }

  function hasCenterThreeByThree(vSig, hSig, pitch, phaseX, phaseY, w, h, peakMed, threshFrac, minLines) {
    return (
      axisHasThreeCells(vSig, pitch, phaseX, w / 2, peakMed, threshFrac, minLines) &&
      axisHasThreeCells(hSig, pitch, phaseY, h / 2, peakMed, threshFrac, minLines)
    );
  }

  /**
   * True when a detected cell has a printed cross / half-grid inside it
   * (mid-band line nearly as strong as the cell borders, and stronger than
   * the quarter bands). Used to catch a doubled pitch (2×2 inside each cell).
   */
  function cellHasInternalCross(imgData, w, h, pitch, phaseX, phaseY, ix, iy, polarity) {
    const d = imgData.data;
    const x0 = phaseX + ix * pitch;
    const y0 = phaseY + iy * pitch;
    const x1 = x0 + pitch;
    const y1 = y0 + pitch;
    if (x0 < 2 || y0 < 2 || x1 > w - 2 || y1 > h - 2) return null;
    const xStart = Math.floor(x0) + 1;
    const xEnd = Math.ceil(x1);
    const yStart = Math.floor(y0) + 1;
    const yEnd = Math.ceil(y1);
    if (xEnd - xStart < 8 || yEnd - yStart < 8) return null;

    const vProf = [];
    const vCoord = [];
    for (let x = xStart; x < xEnd; x++) {
      let s = 0;
      for (let y = yStart + 1; y < yEnd - 1; y++) {
        const g = grayAt(d, w, x, y);
        const nX = 0.5 * (grayAt(d, w, x - 1, y) + grayAt(d, w, x + 1, y));
        s += polarity === "bright" ? Math.max(0, g - nX) : Math.max(0, nX - g);
      }
      vProf.push(s);
      vCoord.push(x);
    }
    const hProf = [];
    const hCoord = [];
    for (let y = yStart; y < yEnd; y++) {
      let s = 0;
      for (let x = xStart + 1; x < xEnd - 1; x++) {
        const g = grayAt(d, w, x, y);
        const nY = 0.5 * (grayAt(d, w, x, y - 1) + grayAt(d, w, x, y + 1));
        s += polarity === "bright" ? Math.max(0, g - nY) : Math.max(0, nY - g);
      }
      hProf.push(s);
      hCoord.push(y);
    }

    function axisHasMid(prof, coords, c0) {
      const edge = [];
      const mid = [];
      const q = [];
      for (let i = 0; i < coords.length; i++) {
        const tt = (coords[i] - c0) / pitch;
        if (tt < 0.1 || tt > 0.9) edge.push(prof[i]);
        else if (tt >= 0.45 && tt <= 0.55) mid.push(prof[i]);
        else if ((tt >= 0.25 && tt <= 0.35) || (tt >= 0.65 && tt <= 0.75)) q.push(prof[i]);
      }
      if (!edge.length || !mid.length || !q.length) return false;
      const e = Math.max(...edge);
      const m = Math.max(...mid);
      const qq = medianOf(q);
      return e > 0 && m >= 0.5 * e && m >= 1.3 * qq;
    }

    return (
      axisHasMid(vProf, vCoord, x0) && axisHasMid(hProf, hCoord, y0)
    );
  }

  /**
   * Sample up to 7 cells around the image center. Returns true when at least
   * 4 contain an internal cross / half-grid (2×2 inside the detected cell).
   */
  function majorityCellsHaveInternalGrid(
    imgData,
    w,
    h,
    pitch,
    phaseX,
    phaseY,
    polarity
  ) {
    if (!(pitch > 0)) return false;
    const p = Math.max(1, Math.round(pitch));
    const kx = Math.round(w / 2 / p - phaseX / p - 0.5);
    const ky = Math.round(h / 2 / p - phaseY / p - 0.5);
    let hits = 0;
    let checked = 0;
    for (let dy = -2; dy <= 2 && checked < 7; dy++) {
      for (let dx = -2; dx <= 2 && checked < 7; dx++) {
        const r = cellHasInternalCross(
          imgData,
          w,
          h,
          p,
          phaseX,
          phaseY,
          kx + dx,
          ky + dy,
          polarity
        );
        if (r == null) continue;
        checked++;
        if (r) hits++;
      }
    }
    return checked >= 3 && hits >= 4;
  }

  function cellsSuggestDoubledPitch(imgData, w, h, pitch, phaseX, phaseY, polarity, minP) {
    if (!(pitch >= 2 * minP - 1e-6)) return false;
    const offsets = [0, pitch / 4];
    for (const ox of offsets) {
      for (const oy of offsets) {
        if (
          majorityCellsHaveInternalGrid(
            imgData,
            w,
            h,
            pitch,
            phaseX + ox,
            phaseY + oy,
            polarity
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function maybeHalvePitch(imgData, w, h, fitted, polarity, minP, maxP, vSig, hSig) {
    let pitch = fitted.pitch;
    let phaseX = fitted.phaseX;
    let phaseY = fitted.phaseY;
    let score = fitted.score;
    for (let step = 0; step < 2; step++) {
      if (pitch / 2 < minP) break;
      if (
        !cellsSuggestDoubledPitch(
          imgData,
          w,
          h,
          pitch,
          phaseX,
          phaseY,
          polarity,
          minP
        )
      ) {
        break;
      }
      const half = pitch / 2;
      const refined = refinePitchAndPhase(
        vSig,
        hSig,
        half,
        minP,
        maxP
      );
      pitch = refined.pitch;
      phaseX = refined.phaseX;
      phaseY = refined.phaseY;
      score = refined.score;
    }
    return { pitch, phaseX, phaseY, score };
  }

  function autocorrAt(signal, lag) {
    const n = signal.length;
    if (lag <= 0 || lag >= n) return 0;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;
    let s = 0;
    let c = 0;
    for (let i = 0; i + lag < n; i++) {
      s += (signal[i] - mean) * (signal[i + lag] - mean);
      c++;
    }
    return c ? s / c : 0;
  }

  /**
   * Fundamental cell pitch from a line-projection. minP is large enough that
   * grass/noise (4–12px) cannot win; harmonics (2×, 3×, 5×) boost the true cell.
   */
  function bestPitch(signal, minP, maxP) {
    const n = signal.length;
    maxP = Math.min(maxP, Math.floor(n / 3));
    if (maxP < minP) return null;
    const raw = new Float64Array(maxP + 1);
    let rawMax = 0;
    for (let lag = minP; lag <= maxP; lag++) {
      raw[lag] = autocorrAt(signal, lag);
      if (raw[lag] > rawMax) rawMax = raw[lag];
    }
    if (!(rawMax > 0)) return null;
    let bestLag = -1;
    let bestScore = -Infinity;
    for (let lag = minP; lag <= maxP; lag++) {
      let s = raw[lag];
      if (lag * 2 <= maxP) s += 0.45 * raw[lag * 2];
      if (lag * 3 <= maxP) s += 0.25 * raw[lag * 3];
      if (lag * 5 <= maxP) s += 0.35 * raw[lag * 5];
      s *= Math.log(8 + lag);
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    if (bestLag < minP) return null;
    for (const div of [2, 3]) {
      const fund = Math.round(bestLag / div);
      if (fund < minP || fund === bestLag) continue;
      if (raw[fund] > 0.55 * raw[bestLag] && Math.abs(bestLag / fund - div) < 0.12) {
        bestLag = fund;
        break;
      }
    }
    return { lag: bestLag, score: bestScore };
  }

  function refinePitchWithFifths(signal, pitch, minP, maxP) {
    const n = signal.length;
    const lo = Math.max(Math.ceil(4.4 * pitch), minP);
    const hi = Math.min(Math.floor(5.6 * pitch), maxP, Math.floor(n / 3));
    if (hi < lo) return pitch;
    let bestLag = -1;
    let best = -Infinity;
    for (let lag = lo; lag <= hi; lag++) {
      const s = autocorrAt(signal, lag);
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    if (bestLag >= 5 * minP) {
      const refined = bestLag / 5;
      if (refined >= minP && refined <= maxP) pitch = refined;
    }
    return pitch;
  }

  /** Sample a 1d projection along a comb of period `pitch` starting at `phase`. */
  function combScore(signal, pitch, phase) {
    const n = signal.length;
    if (!(pitch > 0) || n < 4) return 0;
    let s = 0;
    let c = 0;
    for (let x = phase; x < n - 1; x += pitch) {
      if (x < 0) continue;
      const i = Math.floor(x);
      const f = x - i;
      s += (1 - f) * signal[i] + f * signal[i + 1];
      c++;
    }
    return c ? s / c : 0;
  }

  function combPhase(signal, pitch) {
    if (!(pitch > 0)) return { phase: 0, score: 0 };
    const step = Math.max(0.2, pitch / 100);
    let bestPh = 0;
    let bestS = -Infinity;
    for (let ph = 0; ph < pitch; ph += step) {
      const sc = combScore(signal, pitch, ph);
      if (sc > bestS) {
        bestS = sc;
        bestPh = ph;
      }
    }
    return { phase: bestPh, score: bestS };
  }

  function refinePitchAndPhase(vSig, hSig, pitch0, minP, maxP) {
    const lo = Math.max(minP, pitch0 * 0.96);
    const hi = Math.min(maxP, pitch0 * 1.04);
    const pStep = Math.max(0.05, pitch0 / 400);
    let best = { pitch: pitch0, phaseX: 0, phaseY: 0, score: -Infinity };
    for (let p = lo; p <= hi; p += pStep) {
      const vx = combPhase(vSig, p);
      const hy = combPhase(hSig, p);
      const sc = vx.score + hy.score;
      if (sc > best.score) {
        best = { pitch: p, phaseX: vx.phase, phaseY: hy.phase, score: sc };
      }
    }
    return best;
  }

  /**
   * 0.5.3-style full-image polarity pick: best single lag per polarity (no
   * multi-candidate / 2× hunt). Returns fitted pitch/phase plus the winning
   * projection signals for lattice sanity checks.
   */
  function pickPitchFromProjections(proj, minP, maxP) {
    const polarities = [
      { name: "bright", v: proj.vBright, h: proj.hBright },
      { name: "dark", v: proj.vDark, h: proj.hDark },
    ];
    let best = null;
    for (const pol of polarities) {
      const vHit = bestPitch(pol.v, minP, maxP);
      const hHit = bestPitch(pol.h, minP, maxP);
      if (!vHit && !hHit) continue;
      let pitch;
      let axis = "v";
      if (vHit && hHit) {
        const rel = Math.abs(vHit.lag - hHit.lag) / Math.max(vHit.lag, hHit.lag);
        if (rel < 0.15) {
          pitch = (vHit.lag + hHit.lag) / 2;
          axis = "avg";
        } else if (vHit.score >= hHit.score) {
          pitch = vHit.lag;
          axis = "v";
        } else {
          pitch = hHit.lag;
          axis = "h";
        }
      } else if (vHit) {
        pitch = vHit.lag;
      } else {
        pitch = hHit.lag;
        axis = "h";
      }
      const strip = axis === "h" ? pol.h : pol.v;
      pitch = refinePitchWithFifths(strip, pitch, minP, maxP);
      if (axis === "avg") {
        const p2 = refinePitchWithFifths(pol.h, pitch, minP, maxP);
        pitch = (pitch + p2) / 2;
      }
      if (!(pitch >= minP && pitch <= maxP)) continue;
      const fitted = refinePitchAndPhase(pol.v, pol.h, pitch, minP, maxP);
      if (!best || fitted.score > best.score) {
        best = {
          pitch: fitted.pitch,
          phaseX: fitted.phaseX,
          phaseY: fitted.phaseY,
          score: fitted.score,
          polarity: pol.name,
          vSig: pol.v,
          hSig: pol.h,
        };
      }
    }
    return best;
  }

  /**
   * Shared ROI polarity hunt used by stage 2 (0.5.5 + 0.5.12 pieces).
   * `opts.halve` enables 0.5.5 mid-cell doubling correction.
   * `opts.peakMed` / `opts.threshFrac` select the center-3×3 gate strength.
   * `opts.minLines` how many of the 4 center comb lines must clear the gate (4 or 3).
   * Tries primary lag, the other axis lag, then 2× those (first pass wins per polarity)
   * so a subharmonic autocorr peak cannot block the true cell.
   */
  function detectGridPitchInCenterRois(imgData, w, h, minP, maxP, opts) {
    const fractions = [0.4, 0.55, 0.7];
    const peakMed = opts && opts.peakMed != null ? opts.peakMed : 1.2;
    const threshFrac = opts && opts.threshFrac != null ? opts.threshFrac : 0.35;
    const doHalve = !!(opts && opts.halve);
    const minLines = opts && opts.minLines != null ? opts.minLines : 4;
    let best = null;
    for (const frac of fractions) {
      const roi = centerRoi(w, h, frac);
      if (roi.x1 - roi.x0 < 3.2 * minP || roi.y1 - roi.y0 < 3.2 * minP) continue;
      const proj = lineProjections(imgData, w, h, roi);
      const polarities = [
        { name: "bright", v: proj.vBright, h: proj.hBright },
        { name: "dark", v: proj.vDark, h: proj.hDark },
      ];
      for (const pol of polarities) {
        const vHit = bestPitch(pol.v, minP, maxP);
        const hHit = bestPitch(pol.h, minP, maxP);
        if (!vHit && !hHit) continue;
        const ordered = [];
        const addCand = (p) => {
          if (!(p >= minP && p <= maxP)) return;
          const key = Math.round(p * 2) / 2;
          if (ordered.some((x) => Math.round(x * 2) / 2 === key)) return;
          ordered.push(p);
        };
        if (vHit && hHit) {
          const rel = Math.abs(vHit.lag - hHit.lag) / Math.max(vHit.lag, hHit.lag);
          if (rel < 0.15) addCand((vHit.lag + hHit.lag) / 2);
          addCand(vHit.score >= hHit.score ? vHit.lag : hHit.lag);
          addCand(vHit.lag);
          addCand(hHit.lag);
        } else if (vHit) {
          addCand(vHit.lag);
        } else {
          addCand(hHit.lag);
        }
        for (const p of ordered.slice()) addCand(2 * p);

        for (const pitch0 of ordered) {
          let pitch = refinePitchWithFifths(pol.v, pitch0, minP, maxP);
          const p2 = refinePitchWithFifths(pol.h, pitch, minP, maxP);
          pitch = (pitch + p2) / 2;
          if (!(pitch >= minP && pitch <= maxP)) continue;
          if (roi.x1 - roi.x0 < 3.2 * pitch || roi.y1 - roi.y0 < 3.2 * pitch) continue;
          let fitted = refinePitchAndPhase(pol.v, pol.h, pitch, minP, maxP);
          if (doHalve) {
            fitted = maybeHalvePitch(
              imgData,
              w,
              h,
              fitted,
              pol.name,
              minP,
              maxP,
              pol.v,
              pol.h
            );
          }
          if (
            !hasCenterThreeByThree(
              pol.v,
              pol.h,
              fitted.pitch,
              fitted.phaseX,
              fitted.phaseY,
              w,
              h,
              peakMed,
              threshFrac,
              minLines
            )
          ) {
            continue;
          }
          if (!best || fitted.score > best.score) {
            best = {
              pitch: fitted.pitch,
              phaseX: fitted.phaseX,
              phaseY: fitted.phaseY,
              score: fitted.score,
              polarity: pol.name,
              width: w,
              height: h,
            };
          }
          break; // first passing candidate for this polarity
        }
      }
      if (best) break;
    }
    return best;
  }

  /**
   * Stage 1: 0.5.3 full-image printed-line comb fit (b5c88d4 / 0.5.9).
   * Then a *light* lattice sanity check — 0.5.5-era center 3×3 with peakMed
   * 1.08 / threshFrac 0.22 / **3-of-4** center comb lines (not the strict
   * 0.5.4 1.2/0.35/4-of-4 gate). Wrong non-null pitches (e.g. Jahaka ~50px
   * with no real center lattice) fail and fall through to stage 2.
   */
  function detectGridPitchStage1(imgData, w, h, minP, maxP) {
    const proj = lineProjections(imgData, w, h);
    const hit = pickPitchFromProjections(proj, minP, maxP);
    if (!hit) return null;
    if (
      !hasCenterThreeByThree(
        hit.vSig,
        hit.hSig,
        hit.pitch,
        hit.phaseX,
        hit.phaseY,
        w,
        h,
        1.08,
        0.22,
        3
      )
    ) {
      return null;
    }
    return {
      pitch: hit.pitch,
      phaseX: hit.phaseX,
      phaseY: hit.phaseY,
      score: hit.score,
      polarity: hit.polarity,
      width: w,
      height: h,
      stage: 1,
    };
  }

  /**
   * Stage 2: 0.5.5 center ROI + maybeHalve + looser gate, plus 0.5.12 pieces
   * that help Jahaka (minP floor 14 via caller, multi-candidate lags, 3-of-4
   * center lines). Runs when stage 1 is null or fails lattice sanity.
   */
  function detectGridPitchStage2(imgData, w, h, minP, maxP) {
    const hit = detectGridPitchInCenterRois(imgData, w, h, minP, maxP, {
      peakMed: 1.08,
      threshFrac: 0.22,
      halve: true,
      minLines: 3,
    });
    if (!hit) return null;
    return { ...hit, stage: 2 };
  }

  function detectGridPitch(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 32 || h < 32) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d", { willReadFrequently: true });
    c.imageSmoothingEnabled = false;
    c.drawImage(img, 0, 0);
    let imgData;
    try {
      imgData = c.getImageData(0, 0, w, h);
    } catch (_) {
      return null;
    }
    // Stage 1 uses classic 0.5.3 minP floor 20 (grass/noise rejection).
    // Stage 2 uses floor 14 so ~16px chat-JPG cells (Jahaka) can lock.
    const minP1 = Math.max(20, Math.floor(Math.min(w, h) / 80));
    const minP2 = Math.max(14, Math.floor(Math.min(w, h) / 80));
    const maxP = Math.max(minP2 + 8, Math.floor(Math.min(w, h) / 4));
    const stage1 = detectGridPitchStage1(imgData, w, h, minP1, maxP);
    if (stage1) return stage1;
    return detectGridPitchStage2(imgData, w, h, minP2, maxP);
  }

  /** Active editing map layer, else topmost visible map layer with an image. */
  function layerForWallGridInfer() {
    const editing = editingLayer();
    if (editing && editing.img && editing.img.naturalWidth > 0) return editing;
    for (let i = mapLayers.length - 1; i >= 0; i--) {
      const l = mapLayers[i];
      if (l.visible && l.img && l.img.naturalWidth > 0) return l;
    }
    return null;
  }

  /**
   * Detect wall-like segments and fit a square grid when >50% of wall length
   * aligns. Applies pitch/phase to layer size/position (Has-grid style).
   */
  async function inferGridFromWallsAction() {
    const IG = window.InferGridFromWalls;
    if (!IG || typeof IG.inferGridFromWallImageData !== "function") {
      setStatus("Infer grid from walls: helper not loaded");
      return;
    }
    const layer = layerForWallGridInfer();
    if (!layer) {
      setStatus("Infer grid from walls: no map layer image (Edit a layer or show one)");
      return;
    }
    const img = layer.img;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 32 || h < 32) {
      setStatus("Infer grid from walls: image too small");
      return;
    }
    setStatus(`Inferring grid from walls on “${layer.name || layer.id}”…`);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext("2d", { willReadFrequently: true });
      c.imageSmoothingEnabled = false;
      c.drawImage(img, 0, 0);
      let imgData;
      try {
        imgData = c.getImageData(0, 0, w, h);
      } catch (err) {
        setStatus(`Infer grid from walls: cannot read pixels (${err})`);
        return;
      }
      const minP = Math.max(14, Math.floor(Math.min(w, h) / 80));
      const maxP = Math.max(minP + 8, Math.floor(Math.min(w, h) / 4));
      const hit = IG.inferGridFromWallImageData(imgData, w, h, minP, maxP);
      if (!hit) {
        setStatus(
          "Infer grid from walls: no grid matched >50% of detected wall segments"
        );
        return;
      }
      const detected = {
        pitch: hit.pitch,
        phaseX: hit.phaseX,
        phaseY: hit.phaseY,
        width: w,
        height: h,
        stage: "walls",
      };
      const fitted = await gridFitImage(img, detected);
      // Apply alignment to existing layer (size/position); keep original asset
      // unless crop produced a meaningfully smaller canvas — then re-upload.
      const fullScaleW = w * (gridSize / hit.pitch);
      const fullScaleH = h * (gridSize / hit.pitch);
      const usedCrop =
        fitted.cropped &&
        (Math.abs(fitted.w - fullScaleW) > gridSize * 0.25 ||
          Math.abs(fitted.h - fullScaleH) > gridSize * 0.25);
      if (usedCrop) {
        const cropBuf = await fitted.blob.arrayBuffer();
        const cropName = `maps/${(layer.name || layer.id || "layer")}-wallgrid.png`;
        const uploaded = await postAssetBuffer(cropBuf, "image/png", cropName);
        layer.asset = uploaded.hash;
        layer.img = await loadImageByHash(uploaded.hash);
      }
      layer.x = fitted.x;
      layer.y = fitted.y;
      layer.w = fitted.w;
      layer.h = fitted.h;
      if (snapLayers) snapLayerOnRelease(layer);
      extent = computeExtent(scene);
      const ok = await persistSceneLayers();
      if (!ok) return;
      renderMapLayersList();
      draw();
      const pct = Math.round(hit.score * 100);
      setStatus(
        `Infer grid from walls: pitch ${hit.pitch.toFixed(1)}px · ${pct}% walls aligned` +
          (fitted.cropped ? "" : " · uncropped fallback") +
          (fitted.warning ? ` · ${fitted.warning}` : "")
      );
    } catch (err) {
      setStatus(`Infer grid from walls failed: ${err}`);
    }
  }

  /**
   * Scale so 1 detected cell = 1 map cell. Put detected grid LINES on map grid
   * lines (not the image center). Crop to whole map squares. Marks are never drawn.
   */
  async function gridFitImage(img, detected) {
    const g = gridSize;
    const pitch = detected.pitch;
    const imgW = detected.width;
    const imgH = detected.height;
    const s = g / pitch;
    const phaseX = ((detected.phaseX % pitch) + pitch) % pitch;
    const phaseY = ((detected.phaseY % pitch) + pitch) % pitch;

    // Pixel `phaseX` is a vertical grid line → world x = 0 (a map grid line).
    let x = -phaseX * s;
    let y = -phaseY * s;
    let ww = imgW * s;
    let hh = imgH * s;

    let left = Math.ceil(x / g - 1e-9) * g;
    let top = Math.ceil(y / g - 1e-9) * g;
    let right = Math.floor((x + ww) / g + 1e-9) * g;
    let bottom = Math.floor((y + hh) / g + 1e-9) * g;
    let cropped = true;
    let warning = "";
    if (right <= left || bottom <= top) {
      cropped = false;
      warning =
        "Grid-fit: crop empty after snap — using full scaled image (warning)";
      left = x;
      top = y;
      right = x + ww;
      bottom = y + hh;
    }

    const srcX = (left - x) / s;
    const srcY = (top - y) / s;
    const srcW = (right - left) / s;
    const srcH = (bottom - top) / s;

    const ox = Math.max(0, Math.min(imgW - 1, Math.round(srcX)));
    const oy = Math.max(0, Math.min(imgH - 1, Math.round(srcY)));
    const ow = Math.max(1, Math.min(imgW - ox, Math.round(srcW)));
    const oh = Math.max(1, Math.min(imgH - oy, Math.round(srcH)));

    const canvas = document.createElement("canvas");
    canvas.width = ow;
    canvas.height = oh;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, ow, oh, 0, 0, ow, oh);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/png"
      );
    });

    return {
      blob,
      x: cropped ? left : x,
      y: cropped ? top : y,
      w: cropped ? right - left : ww,
      h: cropped ? bottom - top : hh,
      pitch,
      phaseX,
      phaseY,
      scale: s,
      cropped,
      warning,
    };
  }

  async function postAssetBuffer(buf, contentType, assetName) {
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "X-Asset-Name": assetName,
      },
      body: buf,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Upload failed (${res.status}): ${err.error || ""}`);
    }
    return res.json();
  }

  async function addMapLayerFromFile(file) {
    if (!file) return;
    const wantGridFit = !!(toggleGridFitEl && toggleGridFitEl.checked);
    setStatus(`Uploading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const { hash: originalHash, name } = await postAssetBuffer(
        buf,
        file.type || "application/octet-stream",
        `maps/${file.name}`
      );

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

      let assetHash = originalHash;
      let layerX = 0;
      let layerY = 0;
      let layerW = undefined;
      let layerH = undefined;
      let statusExtra = "";

      if (wantGridFit) {
        try {
          const srcImg = await loadImageFromBlob(new Blob([buf], { type: file.type || "image/png" }));
          const detected = detectGridPitch(srcImg);
          if (!detected) {
            statusExtra =
              " · grid-fit: no grid (0.5.3→0.5.5 stages) — imported at natural size (0,0)";
          } else {
            const fitted = await gridFitImage(srcImg, detected);
            const cropBuf = await fitted.blob.arrayBuffer();
            const cropName = `maps/${file.name.replace(/\.[^.]+$/, "") || "layer"}-gridfit.png`;
            const cropped = await postAssetBuffer(cropBuf, "image/png", cropName);
            assetHash = cropped.hash;
            layerX = fitted.x;
            layerY = fitted.y;
            layerW = fitted.w;
            layerH = fitted.h;
            statusExtra =
              ` · grid-fit ${detected.pitch.toFixed(1)}px cells (stage ${detected.stage || 1}), lines at ${detected.phaseX.toFixed(1)},${detected.phaseY.toFixed(1)}px` +
              (fitted.cropped ? "" : " · uncropped fallback");
            if (fitted.warning) statusExtra += ` · ${fitted.warning}`;
          }
        } catch (fitErr) {
          statusExtra = ` · grid-fit failed (${fitErr}) — imported without fit`;
        }
      }

      const img = await loadImageByHash(assetHash);
      const layer = {
        id,
        name: file.name.replace(/\.[^.]+$/, "") || name || id,
        asset: assetHash,
        visible: true,
        x: layerX,
        y: layerY,
        img,
        flipX: false,
        flipY: false,
        rotation: 0,
      };
      if (layerW != null) layer.w = layerW;
      if (layerH != null) layer.h = layerH;
      mapLayers.push(layer);
      // Ensure scene has layers key including legacy upgrade
      if (!scene.layers) scene.layers = [];
      const ok = await persistSceneLayers();
      if (!ok) return;
      extent = computeExtent(scene);
      renderMapLayersList();
      draw();
      setStatus(
        `Added map layer “${id}” (${assetHash.slice(0, 12)}…)${statusExtra}`
      );
    } catch (err) {
      setStatus(`Upload error: ${err}`);
    }
  }

  btnAddLayer.addEventListener("click", () => {
    layerFileInput.value = "";
    layerFileInput.click();
  });
  const btnInferGridWalls = document.getElementById("btn-infer-grid-walls");
  if (btnInferGridWalls) {
    btnInferGridWalls.addEventListener("click", (e) => {
      e.stopPropagation();
      inferGridFromWallsAction();
    });
  }
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
  if (snapTargetEl) {
    snapTargetEl.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest("button[data-snap-target]");
      if (!btn) return;
      const mode = btn.getAttribute("data-snap-target");
      if (mode !== "center" && mode !== "corner") return;
      snapTarget = mode;
      syncSnapTargetUi();
      scheduleUiPersist();
    });
  }
  if (toggleNametagsEl) {
    toggleNametagsEl.addEventListener("change", () => {
      showNametags = !!toggleNametagsEl.checked;
      draw();
      scheduleUiPersist();
    });
  }
  if (toggleSnapLayersEl) {
    toggleSnapLayersEl.addEventListener("change", () => {
      snapLayers = !!toggleSnapLayersEl.checked;
      scheduleUiPersist();
    });
  }

  const btnLayerScale = document.getElementById("btn-layer-scale");
  const btnLayerFlipH = document.getElementById("btn-layer-flip-h");
  const btnLayerFlipV = document.getElementById("btn-layer-flip-v");
  const btnLayerRotate = document.getElementById("btn-layer-rotate");
  const scaleDialog = document.getElementById("layer-scale-dialog");
  const scaleTilesW = document.getElementById("scale-tiles-w");
  const scaleTilesH = document.getElementById("scale-tiles-h");
  const scaleApply = document.getElementById("scale-apply");
  const scaleCancel = document.getElementById("scale-cancel");

  function requireEditingLayer() {
    const layer = editingLayer();
    if (!layer) {
      setStatus("Select Edit on a map layer first");
      return null;
    }
    ensureLayerSize(layer);
    return layer;
  }

  function openScaleDialog() {
    const layer = requireEditingLayer();
    if (!layer || !scaleDialog) return;
    const tiles = layerTileSize(layer);
    if (scaleTilesW) scaleTilesW.value = tiles ? String(tiles.w) : "10";
    if (scaleTilesH) scaleTilesH.value = tiles ? String(tiles.h) : "10";
    if (typeof scaleDialog.showModal === "function") scaleDialog.showModal();
    else scaleDialog.setAttribute("open", "");
  }

  function applyScaleDialog() {
    const layer = requireEditingLayer();
    if (!layer) return;
    const tw = Math.max(0.5, Number(scaleTilesW && scaleTilesW.value) || 0);
    const th = Math.max(0.5, Number(scaleTilesH && scaleTilesH.value) || 0);
    layer.w = tw * gridSize;
    layer.h = th * gridSize;
    if (snapLayers) snapLayerOnRelease(layer);
    draw();
    renderMapLayersList();
    persistSceneLayers();
    setStatus(`Scaled ${layer.name} to ${tw}×${th} tiles`);
    if (scaleDialog) {
      if (typeof scaleDialog.close === "function") scaleDialog.close();
      else scaleDialog.removeAttribute("open");
    }
  }

  function toggleLayerFlip(axis) {
    const layer = requireEditingLayer();
    if (!layer) return;
    if (axis === "h") layer.flipX = !layer.flipX;
    else layer.flipY = !layer.flipY;
    draw();
    persistSceneLayers();
    setStatus(
      `${layer.name}: flip ${axis.toUpperCase()} ${axis === "h" ? (layer.flipX ? "on" : "off") : layer.flipY ? "on" : "off"}`
    );
  }

  function rotateLayerCw() {
    const layer = requireEditingLayer();
    if (!layer) return;
    const prev = layerRotation(layer);
    const next = (prev + 90) % 360;
    // Keep axis-aligned bounds: swap w/h on odd 90° steps.
    const w = Number(layer.w) || 0;
    const h = Number(layer.h) || 0;
    if (w > 0 && h > 0) {
      layer.w = h;
      layer.h = w;
    }
    layer.rotation = next;
    if (snapLayers) snapLayerOnRelease(layer);
    draw();
    renderMapLayersList();
    persistSceneLayers();
    setStatus(`${layer.name}: rotated to ${next}°`);
  }

  if (btnLayerScale) btnLayerScale.addEventListener("click", openScaleDialog);
  if (btnLayerFlipH) btnLayerFlipH.addEventListener("click", () => toggleLayerFlip("h"));
  if (btnLayerFlipV) btnLayerFlipV.addEventListener("click", () => toggleLayerFlip("v"));
  if (btnLayerRotate) btnLayerRotate.addEventListener("click", rotateLayerCw);
  if (scaleApply) scaleApply.addEventListener("click", applyScaleDialog);
  if (scaleCancel) {
    scaleCancel.addEventListener("click", () => {
      if (!scaleDialog) return;
      if (typeof scaleDialog.close === "function") scaleDialog.close();
      else scaleDialog.removeAttribute("open");
    });
  }

  window.__gmUpdateStatus = function (msg, done) {
    const text = String(msg || "");
    setUpdateStatus(text);
    setStatus(text);
    if (done && btnUpdate) btnUpdate.disabled = false;
  };

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
    setUpdateStatus("Looking for installer on GitHub…");
    try {
      const msg = await Promise.resolve(api.check_update());
      setUpdateStatus(String(msg || "Looking for installer on GitHub…"));
    } catch (err) {
      const text = err && err.message ? err.message : String(err);
      setUpdateStatus(`Failed: ${text}`);
      setStatus(`Update app failed: ${text}`);
      if (btnUpdate) btnUpdate.disabled = false;
    }
  }

  if (btnUpdate) {
    btnUpdate.addEventListener("click", (e) => {
      e.stopPropagation();
      runUpdateCheck();
    });
  }

  function canvasLocal(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  /** Topmost token under screen point, or null. Tokens sit above map pan. */
  function hitTestToken(sx, sy) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      const [cx, cy] = worldToScreen(t.x, t.y);
      const r = tokenRadiusScreen(t);
      const dx = sx - cx;
      const dy = sy - cy;
      if (dx * dx + dy * dy <= r * r) return t;
    }
    return null;
  }

  function selectToken(token) {
    if (!token) {
      selectedTokenId = null;
      draw();
      return;
    }
    selectedTokenId = token.id;
    if (token.actor_id) {
      selectedActorId = token.actor_id;
      renderLibrarySelection();
    }
    const size = tokenSizeTiles(token);
    setStatus(`Selected “${token.name || token.id}” · ${size} tile(s) across`);
    const hint = document.getElementById("header-hint");
    if (hint) {
      hint.textContent = `Selected: ${token.name || token.id} · Delete to remove · Double-click for sheet · Drag to move`;
    }
    draw();
  }

  function clearTokenSelection({ updateHint = true } = {}) {
    if (!selectedTokenId) return;
    selectedTokenId = null;
    draw();
    if (updateHint) {
      const hint = document.getElementById("header-hint");
      if (hint) {
        hint.textContent =
          "Click token to select · Delete removes token/layer · Double-click token for sheet · Drag actors onto map · Wheel zoom";
      }
    }
  }

  function applyAppearanceToTokens(actorId, appearance) {
    if (!actorId) return;
    let size = Number(appearance && appearance.size_tiles);
    if (!(size > 0)) size = 1;
    let changed = 0;
    for (const t of tokens) {
      if (t.actor_id === actorId) {
        t.size_tiles = size;
        changed++;
      }
    }
    // Keep library cache in sync for future placements
    if (library && Array.isArray(library.actors)) {
      for (const a of library.actors) {
        if (a.id === actorId) {
          a.size_tiles = size;
          a.appearance = { ...(a.appearance || {}), size_tiles: size };
        }
      }
    }
    if (changed) {
      schedulePersist();
      draw();
      setStatus(
        `Appearance: ${actorId} → ${size} tile(s) across · updated ${changed} token(s)`
      );
    } else {
      setStatus(`Appearance saved for ${actorId} (no tokens on this scene)`);
    }
  }

  window.__gmSessionApplyAppearance = function (actorId, appearance) {
    applyAppearanceToTokens(actorId, appearance || {});
  };

  try {
    if (typeof BroadcastChannel !== "undefined") {
      const appearanceCh = new BroadcastChannel("gm-session-appearance");
      appearanceCh.onmessage = (ev) => {
        const data = ev && ev.data;
        if (!data || !data.actor_id) return;
        applyAppearanceToTokens(data.actor_id, data.appearance || {});
      };
    }
  } catch (_) {}

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

    // Aspect on corners; edge handles still stretch one axis (affectW/affectH).
    if (isCorner) {
      const useW = Math.abs(w - origin.lw) >= Math.abs(h - origin.lh);
      if (useW) {
        h = Math.max(minSize, w / aspect);
      } else {
        w = Math.max(minSize, h * aspect);
      }
      if (handle.includes("w")) x = right - w;
      else x = origin.lx;
      if (handle.includes("n")) y = bottom - h;
      else y = origin.ly;
    }

    layer.x = x;
    layer.y = y;
    layer.w = w;
    layer.h = h;
  }


  /** True if event target is Update/Rolls (or other) chrome over the map. */
  function isMapChrome(el) {
    if (!el || typeof el.closest !== "function") return false;
    return Boolean(el.closest("#update-bar, #roll-dock, .map-chrome"));
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
    if (isMapChrome(e.target)) return;
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
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    pointerMoved = false;
    if (hit) {
      dragMode = "token";
      draggingToken = hit;
      draggingLayer = null;
      dragging = false;
      selectToken(hit);
      viewport.classList.remove("dragging");
      viewport.style.cursor = "grabbing";
      viewport.setPointerCapture(e.pointerId);
      return;
    }

    // 3) Pan (empty space)
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
      if (Math.abs(e.clientX - pointerDownX) > 4 || Math.abs(e.clientY - pointerDownY) > 4) {
        pointerMoved = true;
      }
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
      if (Math.abs(e.clientX - pointerDownX) > 4 || Math.abs(e.clientY - pointerDownY) > 4) {
        pointerMoved = true;
      }
      offsetX += e.clientX - lastX;
      offsetY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      draw();
    }
  });

  function endDrag(e) {
    const wasPan = dragMode === "pan";
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
    // Click empty map (little/no pan movement) clears token selection
    if (wasPan && !pointerMoved) {
      clearTokenSelection();
    }
    dragMode = "none";
    draggingToken = null;
    draggingLayer = null;
    resizeHandle = null;
    layerDragOrigin = null;
    dragging = false;
    pointerMoved = false;
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
      if (isMapChrome(e.target)) return;
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

  viewport.addEventListener("dblclick", (e) => {
    if (isMapChrome(e.target)) return;
    const [sx, sy] = canvasLocal(e);
    const hit = hitTestToken(sx, sy);
    if (hit && hit.actor_id) {
      selectToken(hit);
      openSheet(hit.actor_id);
      return;
    }
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


  // Belt-and-suspenders: map chrome must not bubble into viewport pan/fit
  function stopMapChromeBubble(e) {
    e.stopPropagation();
  }
  for (const id of ["update-bar", "roll-dock"]) {
    const chrome = document.getElementById(id);
    if (!chrome) continue;
    for (const type of ["pointerdown", "dblclick", "click"]) {
      chrome.addEventListener(type, stopMapChromeBubble);
    }
  }

  // --- Rolls pop-out (bottom-right button) ---
  function openRolls() {
    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.open_rolls === "function"
        ? window.pywebview.api
        : null;

    if (api) {
      Promise.resolve(api.open_rolls())
        .then(() => setStatus("Rolls window opened"))
        .catch((err) =>
          setStatus(`Could not open rolls: ${err && err.message ? err.message : err}`)
        );
      return;
    }

    // Browser / serve.py fallback: open the standalone page.
    const w = window.open(
      "/rolls.html",
      "gm-session-rolls",
      "width=420,height=560,menubar=no,toolbar=no,location=no,status=no"
    );
    if (w) {
      setStatus("Rolls window opened");
    } else {
      setStatus(
        "Could not open Rolls window (popup blocked?). Use the GM Session desktop app, or allow pop-ups for this origin."
      );
    }
  }

  const btnRolls = document.getElementById("btn-rolls");
  if (btnRolls) {
    btnRolls.addEventListener("click", (e) => {
      e.stopPropagation();
      openRolls();
    });
  }

  // --- Sheet builder pop-out ---
  function openSheetBuilder(sheetId) {
    const id = (sheetId || "player").trim() || "player";
    const api =
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api.open_sheet_builder === "function"
        ? window.pywebview.api
        : null;

    if (api) {
      Promise.resolve(api.open_sheet_builder(id))
        .then(() => setStatus(`Sheet builder opened (${id})`))
        .catch((err) =>
          setStatus(
            `Could not open sheet builder: ${err && err.message ? err.message : err}`
          )
        );
      return;
    }

    const w = window.open(
      `/sheet-builder.html?sheet=${encodeURIComponent(id)}`,
      "gm-session-sheet-builder",
      "width=1100,height=720,menubar=no,toolbar=no,location=no,status=no"
    );
    if (w) {
      setStatus(`Sheet builder opened (${id})`);
    } else {
      setStatus(
        "Could not open Sheet builder (popup blocked?). Use the GM Session desktop app, or allow pop-ups for this origin."
      );
    }
  }

  const btnSheetBuilder = document.getElementById("btn-sheet-builder");
  if (btnSheetBuilder) {
    btnSheetBuilder.addEventListener("click", (e) => {
      e.stopPropagation();
      openSheetBuilder("player");
    });
  }

  function isTypingTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function removeSelectedToken() {
    if (!selectedTokenId) return false;
    const id = selectedTokenId;
    const before = tokens.length;
    tokens = tokens.filter((t) => t.id !== id);
    if (tokens.length === before) return false;
    selectedTokenId = null;
    draw();
    schedulePersist();
    const hint = document.getElementById("header-hint");
    if (hint) {
      hint.textContent =
        "Click token to select · Delete removes token/layer · Double-click token for sheet · Drag actors onto map · Wheel zoom";
    }
    setStatus(`Removed token · ${tokens.length} remaining`);
    return true;
  }

  window.addEventListener("keydown", (e) => {
    if (
      (e.key !== "Delete" && e.key !== "Backspace") ||
      e.altKey ||
      e.metaKey ||
      e.ctrlKey
    ) {
      return;
    }
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) {
      return;
    }
    if (selectedTokenId) {
      e.preventDefault();
      removeSelectedToken();
      return;
    }
    if (editingLayerId) {
      const layer = editingLayer();
      if (layer) {
        e.preventDefault();
        deleteLayer(layer);
      }
    }
  });

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
