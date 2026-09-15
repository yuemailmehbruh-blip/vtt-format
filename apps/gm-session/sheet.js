(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const actorId = params.get("actor");
  const titleEl = document.getElementById("title");
  const pathEl = document.getElementById("path");
  const textEl = document.getElementById("sheet-text");
  const statusEl = document.getElementById("status");

  function setStatus(msg) {
    statusEl.textContent = msg || "";
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
    setStatus("Ready");
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

  document.getElementById("save").addEventListener("click", () => {
    save().catch((err) => setStatus(String(err)));
  });

  load().catch((err) => setStatus(String(err)));
})();
