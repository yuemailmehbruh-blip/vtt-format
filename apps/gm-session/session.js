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

  const params = new URLSearchParams(location.search);
  let sceneId = params.get("scene") || "docks";

  /** @type {any} */
  let scene = null;
  /** @type {HTMLImageElement|null} */
  let bgImage = null;
  /** @type {any[]} */
  let tokens = [];
  /** @type {any|null} */
  let library = null;
  let selectedActorId = null;
  let currentSheetActorId = null;

  let extent = { x: 0, y: 0, w: 1400, h: 1400 };
  let gridSize = 70;

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
    return pts;
  }

  function computeExtent(sc, img) {
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

  function drawGrid() {
    const g = gridSize;
    const startCol = Math.floor(extent.x / g);
    const endCol = Math.ceil((extent.x + extent.w) / g);
    const startRow = Math.floor(extent.y / g);
    const endRow = Math.ceil((extent.y + extent.h) / g);

    ctx.save();
    ctx.strokeStyle = "rgba(200, 210, 230, 0.35)";
    ctx.lineWidth = 1;

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

    ctx.strokeStyle = "rgba(230, 235, 250, 0.7)";
    ctx.lineWidth = 2;
    const [bx, by] = worldToScreen(extent.x, extent.y);
    ctx.strokeRect(bx, by, extent.w * scale, extent.h * scale);
    ctx.restore();
  }

  function drawBackground() {
    if (!bgImage || !bgImage.complete || bgImage.naturalWidth === 0) return;
    const [sx, sy] = worldToScreen(0, 0);
    let dw = bgImage.naturalWidth;
    let dh = bgImage.naturalHeight;
    const pts = collectPoints(scene);
    let maxX = 0;
    let maxY = 0;
    for (const [x, y] of pts) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (dw < maxX * 0.5 || dh < maxY * 0.5) {
      dw = Math.max(maxX, gridSize);
      dh = Math.max(maxY, gridSize);
    }
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bgImage, sx, sy, dw * scale, dh * scale);
    ctx.restore();
  }

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

  function drawTokens() {
    ctx.save();
    for (const t of tokens) {
      const [cx, cy] = worldToScreen(t.x, t.y);
      const r = Math.max(10, (gridSize * 0.35) * Math.min(scale, 2));
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

  function draw() {
    const rect = viewport.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!scene) return;

    drawBackground();
    drawGrid();
    drawWalls();
    drawDoors();
    drawLights();
    drawSpawns();
    drawTokens();
  }

  function loadBackground(hash) {
    return new Promise((resolve) => {
      if (!hash) {
        bgImage = null;
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        bgImage = img;
        resolve(img);
      };
      img.onerror = () => {
        bgImage = null;
        setStatus("Background asset missing or unreadable");
        resolve(null);
      };
      img.src = `/assets/${hash}`;
    });
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

  function placeToken(actor, worldX, worldY) {
    const name = actor.name || actor.id;
    tokens.push({
      id: `${actor.id}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      actor_id: actor.id,
      name,
      label: initials(name),
      x: worldX,
      y: worldY,
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

    const bgHash =
      scene.background ||
      (scene.layers || []).find((l) => l.asset)?.asset;
    await loadBackground(bgHash);
    await loadTokens();
    extent = computeExtent(scene, bgImage);
    if (fit) fitToView();
    setStatus(
      `${Math.round(extent.w / gridSize)}×${Math.round(extent.h / gridSize)} tiles` +
        (bgImage ? " · background loaded" : "") +
        ` · ${tokens.length} token(s)`
    );
    renderLibrarySelection();
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

  /** @type {Map<string, Window>} */
  const sheetWindows = new Map();

  function openSheet(actorId) {
    selectedActorId = actorId;
    currentSheetActorId = actorId;
    renderLibrarySelection();

    const existing = sheetWindows.get(actorId);
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }

    const features =
      "popup=yes,width=480,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";
    const w = window.open(
      `/sheet.html?actor=${encodeURIComponent(actorId)}`,
      `vtt-sheet-${actorId}`,
      features
    );
    if (!w) {
      setStatus("Pop-up blocked — allow pop-ups for character sheets");
      return;
    }
    sheetWindows.set(actorId, w);
    setStatus(`Sheet opened: ${actorId}`);
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

  // Token drag wins over map pan when pointer is on a token
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
      draggingToken.x = wx;
      draggingToken.y = wy;
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

  // Drop tokens from library
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
