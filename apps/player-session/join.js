(() => {
  "use strict";
  // 0.7.1 join window: only the connect form. On a successful join the desktop app
  // opens the player session window and closes this one.
  const $ = (id) => document.getElementById(id);
  const msg = $("msg");
  const say = (text, cls) => {
    msg.textContent = text || "";
    msg.className = cls || "";
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, method, body) {
    const res = await fetch(path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function opened() {
    const bridge = window.pywebview && window.pywebview.api;
    if (bridge && typeof bridge.joined === "function") bridge.joined();
    else location.href = "/index.html";
  }

  async function init() {
    try {
      const st = await api("/papi/status");
      $("gm").value = st.last_gm || "";
      $("name").value = st.name || "";
      $("ver").textContent = st.version ? `v${st.version}` : "";
    } catch (_) {}
    ($("gm").value ? $("name").value ? $("go") : $("name") : $("gm")).focus();
  }

  $("join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = $("go");
    go.disabled = true;
    say("Connecting…");
    try {
      await api("/papi/connect", "POST", { gm: $("gm").value, name: $("name").value, join_code: $("code").value });
      const t0 = Date.now();
      for (;;) {
        const st = await api("/papi/status");
        if (st.state === "connected") {
          say("Joined ✓", "ok");
          opened();
          return;
        }
        if (st.state === "error" && st.last_error && /code|name|rejected|forbidden|denied/i.test(st.last_error)) {
          throw new Error(st.last_error);
        }
        if (Date.now() - t0 > 12000) throw new Error(st.last_error || "GM did not answer — check the address and that the GM app is running");
        await sleep(300);
      }
    } catch (err) {
      await api("/papi/disconnect", "POST").catch(() => {});
      say(String(err.message || err), "bad");
      go.disabled = false;
    }
  });

  init();
})();
