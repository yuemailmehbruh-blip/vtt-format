(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const chip = $("status-chip");
  const lastSyncEl = $("last-sync");
  const sheetsEl = $("sheets");
  const frame = $("sheet-frame");
  let current = null;
  let firstStatus = true;
  const LABEL = { connected: "Connected", offline: "Offline — edits are queued", connecting: "Connecting…", error: "Connection refused", "not-configured": "Not connected" };

  async function api(path, method = "GET", body) {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.last_error || `HTTP ${res.status}`);
    return data;
  }

  function fmtTime(t) {
    return t ? new Date(t * 1000).toLocaleTimeString() : "never";
  }

  function render(st) {
    const state = st.state || "not-configured";
    chip.className = `chip ${state}`;
    chip.textContent = LABEL[state] || state;
    lastSyncEl.textContent = `Last sync: ${fmtTime(st.last_sync)}`;
    $("gm-label").textContent = st.gm ? `GM ${st.gm}${st.campaign_name ? ` · ${st.campaign_name}` : ""}` : "";
    $("err").textContent = st.last_error && state !== "connected" ? st.last_error : "";
    $("who").textContent = `You: ${st.name || "?"} · player id ${String(st.player_id || "").slice(0, 8)}… · v${st.version || "?"}`;
    if (firstStatus) {
      $("gm").value = st.gm || "";
      $("name").value = st.name || "";
      firstStatus = false;
    }
    const sheets = st.sheets || [];
    $("empty").hidden = sheets.length > 0;
    sheetsEl.innerHTML = "";
    for (const s of sheets) {
      const el = document.createElement("div");
      el.className = "sheet-item" + (s.id === current ? " active" : "");
      el.dataset.id = s.id;
      el.innerHTML = `<span class="n"></span><span class="p"></span>`;
      el.querySelector(".n").textContent = s.name;
      const p = el.querySelector(".p");
      p.textContent = s.pending ? `${s.pending} waiting` : "synced";
      p.classList.toggle("ok", !s.pending);
      el.addEventListener("click", () => openSheet(s.id));
      sheetsEl.appendChild(el);
    }
    if (current && !sheets.some((s) => s.id === current)) {
      current = null;
      frame.hidden = true;
      $("placeholder").hidden = false;
      $("placeholder").textContent = "That sheet is no longer assigned to you.";
    }
    if (!current && sheets.length === 1) openSheet(sheets[0].id);
    $("btn-full").disabled = !current || state !== "connected";
  }

  function openSheet(id) {
    current = id;
    frame.src = `/sheet.html?actor=${encodeURIComponent(id)}&mode=player`;
    frame.hidden = false;
    $("placeholder").hidden = true;
    for (const el of sheetsEl.querySelectorAll(".sheet-item")) el.classList.toggle("active", el.dataset.id === id);
  }

  async function poll() {
    try {
      render(await api("/papi/status"));
    } catch (_) {}
  }

  $("btn-connect").addEventListener("click", async () => {
    try {
      render(await api("/papi/connect", "POST", { gm: $("gm").value, name: $("name").value, join_code: $("code").value }));
      setTimeout(poll, 800);
    } catch (err) {
      $("err").textContent = String(err.message || err);
    }
  });
  $("btn-disconnect").addEventListener("click", async () => {
    await api("/papi/disconnect", "POST").catch(() => {});
    poll();
  });
  $("btn-sync-now").addEventListener("click", async () => {
    try {
      render(await api("/papi/sync-now", "POST"));
    } catch (err) {
      $("err").textContent = String(err.message || err);
      poll();
    }
  });

  const dlg = $("confirm");
  $("confirm-cancel").addEventListener("click", () => dlg.close("cancel"));
  $("confirm-ok").addEventListener("click", () => dlg.close("ok"));
  $("btn-full").addEventListener("click", () => {
    if (!current) return;
    const name = sheetsEl.querySelector(".sheet-item.active .n")?.textContent || current;
    $("confirm-msg").textContent = `Send your whole copy of “${name}” to the GM? It replaces the GM's copy of every field and the notes (the GM's newer edits to this sheet are overwritten).`;
    dlg.returnValue = "";
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return;
      try {
        const out = await api(`/papi/fullsync/${encodeURIComponent(current)}`, "POST");
        $("err").textContent = "";
        lastSyncEl.textContent = `Full Sync sent (${out.applied} value(s) changed on the GM)`;
      } catch (err) {
        $("err").textContent = String(err.message || err);
      }
    };
    dlg.showModal();
  });

  poll();
  setInterval(poll, 1000);
})();
