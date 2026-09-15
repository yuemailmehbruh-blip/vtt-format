(() => {
  "use strict";

  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const viewport = document.getElementById("viewport");
  const nameEl = document.getElementById("scene-name");
  const metaEl = document.getElementById("scene-meta");
  const statusEl = document.getElementById("status");

  const params = new URLSearchParams(location.search);
  const sceneId = params.get("scene") || "docks";

  /** @type {any} */
  let scene = null;
  /** @type {HTMLImageElement|null} */
  let bgImage = null;
  let extent = { x: 0, y: 0, w: 1400, h: 1400 };
  let gridSize = 70;

  // Camera: world -> screen via scale + offset
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function setStatus(msg) {
    statusEl.textContent = msg || "";
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
      // Prefer background pixel size when it looks like a real map
      // (larger than a tiny placeholder relative to geometry).
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const geomW = Number.isFinite(maxX - minX) ? maxX - minX : 0;
      const geomH = Number.isFinite(maxY - minY) ? maxY - minY : 0;
      if (iw >= geomW * 0.5 && ih >= geomH * 0.5 && (iw > g || ih > g)) {
        return { x: 0, y: 0, w: iw, h: ih };
      }
      // Tiny placeholder: still use geometry, but stretch bg later.
    }

    if (!Number.isFinite(minX)) {
      // Sensible default 20x20 cells
      return { x: 0, y: 0, w: 20 * g, h: 20 * g };
    }

    const pad = g;
    minX = Math.min(0, minX) - pad;
    minY = Math.min(0, minY) - pad;
    maxX = maxX + pad;
    maxY = maxY + pad;

    // Snap extent to grid cells for a clean look
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
    offsetX = margin + (rect.width - margin * 2 - extent.w * scale) / 2 - extent.x * scale;
    offsetY = margin + (rect.height - margin * 2 - extent.h * scale) / 2 - extent.y * scale;
  }

  function worldToScreen(x, y) {
    return [x * scale + offsetX, y * scale + offsetY];
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

    // Outer border stronger
    ctx.strokeStyle = "rgba(230, 235, 250, 0.7)";
    ctx.lineWidth = 2;
    const [bx, by] = worldToScreen(extent.x, extent.y);
    ctx.strokeRect(bx, by, extent.w * scale, extent.h * scale);
    ctx.restore();
  }

  function drawBackground() {
    if (!bgImage || !bgImage.complete || bgImage.naturalWidth === 0) return;
    const [sx, sy] = worldToScreen(0, 0);
    // Stretch placeholder (or real map) over scene origin size from geometry.
    // If image matches extent from computeExtent, draw 1:1 in world px.
    let dw = bgImage.naturalWidth;
    let dh = bgImage.naturalHeight;
    const geomRight = extent.x + extent.w;
    const geomBottom = extent.y + extent.h;
    // When image is much smaller than map geometry, stretch to cover 0..maxGeom
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
      // Door mid marker
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
      grad.addColorStop(bright > 0 ? Math.min(0.85, bright / Math.max(r, 1)) : 0.4, "rgba(255, 180, 60, 0.22)");
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

  async function boot() {
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

    const bgHash = scene.background || (scene.layers || []).find((l) => l.asset)?.asset;
    await loadBackground(bgHash);
    extent = computeExtent(scene, bgImage);
    fitToView();
    setStatus(
      `${Math.round(extent.w / gridSize)}×${Math.round(extent.h / gridSize)} tiles` +
        (bgImage ? " · background loaded" : "")
    );
    draw();
  }

  // Interactions
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    viewport.classList.add("dragging");
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    offsetX += e.clientX - lastX;
    offsetY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    draw();
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove("dragging");
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

  window.addEventListener("resize", resize);
  resize();
  boot().catch((err) => {
    console.error(err);
    setStatus(String(err));
  });
})();
