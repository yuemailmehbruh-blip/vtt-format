(() => {
  "use strict";
  // GM "Rolls & Chat" pop-out window. 0.7.2: the UI is the shared RollsChat component
  // (rolls-chat.js/.css) — the player's sidebar mounts the very same component. This
  // file only wires the GM transport: the authoritative log on this server
  // (state/chat/session.jsonl) via /api/chat, long-polled.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function post(body) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) return { ok: false, error: (data && data.error) || "server unreachable" };
    return { ok: true, entry: data.entry, epoch: data.epoch };
  }

  const rc = RollsChat.mount(document.getElementById("rolls-chat-root"), {
    post,
    canClear: true,
    onClear: async (setStatus) => {
      if (!window.confirm("Clear the session chat for everyone? (The old log is kept in the campaign trash.)")) return;
      const res = await fetch("/api/chat", { method: "DELETE" }).catch(() => null);
      setStatus(res && res.ok ? "Chat cleared" : "Clear failed");
    },
  });

  async function loop() {
    let wait = 0;
    for (;;) {
      try {
        const q = rc.epoch === null ? "after=0" : `after=${rc.seq}&epoch=${encodeURIComponent(rc.epoch)}`;
        const res = await fetch(`/api/chat?${q}&wait=${wait}`);
        if (!res.ok) throw new Error(String(res.status));
        rc.merge(await res.json());
        wait = 20;
        rc.setStatus("Live");
      } catch (_) {
        rc.setStatus("Reconnecting…");
        await sleep(2000);
      }
    }
  }

  // Sheets post rolls straight to /api/chat; the old desktop bridge call is a no-op now.
  window.__gmAppendRoll = () => {};
  loop();
})();
