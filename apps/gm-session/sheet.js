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

  /** @type {any} */
  let appearance = { size_tiles: 1 };

  const APPEARANCE_CHANNEL = "gm-session-appearance";

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
    pathEl.textContent = data.path || "";
    textEl.value = data.text || "";
    appearance =
      data.appearance && typeof data.appearance === "object"
        ? data.appearance
        : { size_tiles: 1 };
    let size = Number(appearance.size_tiles);
    if (!(size > 0)) size = 1;
    appearance.size_tiles = size;
    sizeTilesEl.value = String(size);
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
    setStatus(`Saved · ${data.path}`);
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
