/**
 * Shared sheet automation runtime (session sheet + optional tooling).
 * Closed formulas + named-function DAG evaluation (entry / roll / send_to_chat / field / op / const).
 */
(function (global) {
  "use strict";

  /**
   * Closed formula language: identifiers, numbers, + - * /, parentheses, floor(...).
   * @param {string} expr
   * @param {Record<string, number>} env
   */
  function evalClosedFormula(expr, env) {
    const src = String(expr || "").trim();
    if (!src) return NaN;
    let i = 0;

    function peek() {
      while (i < src.length && /\s/.test(src[i])) i++;
      return src[i];
    }

    function match(ch) {
      if (peek() === ch) {
        i++;
        return true;
      }
      return false;
    }

    function parseIdent() {
      peek();
      const start = i;
      if (!/[A-Za-z_]/.test(src[i] || "")) return null;
      i++;
      while (/[A-Za-z0-9_]/.test(src[i] || "")) i++;
      return src.slice(start, i);
    }

    function parseNumber() {
      peek();
      const start = i;
      if (!/[0-9.]/.test(src[i] || "")) return null;
      while (/[0-9]/.test(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (/[0-9]/.test(src[i] || "")) i++;
      }
      const n = Number(src.slice(start, i));
      return Number.isFinite(n) ? n : null;
    }

    function parsePrimary() {
      peek();
      if (match("(")) {
        const v = parseExpr();
        if (!match(")")) throw new Error("expected )");
        return v;
      }
      const ident = parseIdent();
      if (ident) {
        if (ident === "floor") {
          if (!match("(")) throw new Error("floor expects (");
          const v = parseExpr();
          if (!match(")")) throw new Error("expected )");
          return Math.floor(v);
        }
        const raw = env[ident];
        const n = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(n) ? n : 0;
      }
      const num = parseNumber();
      if (num != null) return num;
      throw new Error("unexpected token at " + i);
    }

    function parseUnary() {
      peek();
      if (match("-")) return -parseUnary();
      if (match("+")) return parseUnary();
      return parsePrimary();
    }

    function parseTerm() {
      let v = parseUnary();
      for (;;) {
        peek();
        if (match("*")) v *= parseUnary();
        else if (match("/")) {
          const d = parseUnary();
          v = d === 0 ? NaN : v / d;
        } else break;
      }
      return v;
    }

    function parseExpr() {
      let v = parseTerm();
      for (;;) {
        peek();
        if (match("+")) v += parseTerm();
        else if (match("-")) v -= parseTerm();
        else break;
      }
      return v;
    }

    const result = parseExpr();
    peek();
    if (i < src.length) throw new Error("trailing junk");
    return result;
  }

  function rollDie(sides) {
    const n = Math.max(2, Math.floor(Number(sides) || 20));
    return 1 + Math.floor(Math.random() * n);
  }

  function arityOf(node) {
    if (!node) return 0;
    if (node.kind === "op") {
      if (node.op === "floor") return 1;
      return 2;
    }
    if (node.kind === "field" && node.role === "output") return 1;
    if (node.kind === "roll") return 1;
    if (node.kind === "send_to_chat" || node.kind === "chat") return 1;
    return 0;
  }

  /**
   * Evaluate a named automation starting at an entry (or function) node.
   * @param {{ nodes?: object[], edges?: object[] }} graph
   * @param {string} functionId
   * @param {Record<string, number|string>} fieldEnv
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   values: Record<string, number>,
   *   writes: Record<string, number>,
   *   rolls: { sides: number, result: number, nodeId: string }[],
   *   messages: { text: string, value: number, detail?: string, nodeId: string }[]
   * }}
   */
  function evaluateNamedFunction(graph, functionId, fieldEnv) {
    const name = String(functionId || "").trim();
    const nodes = (graph && graph.nodes) || [];
    const edges = (graph && graph.edges) || [];
    if (!name) {
      return { ok: false, error: "Missing function id", values: {}, writes: {}, rolls: [], messages: [] };
    }

    const byId = Object.create(null);
    for (const n of nodes) byId[n.id] = n;

    const entry = nodes.find(
      (n) =>
        (n.kind === "entry" || n.kind === "function") &&
        String(n.name || "").trim() === name
    );
    if (!entry) {
      return {
        ok: false,
        error: `No entry function named "${name}"`,
        values: {},
        writes: {},
        rolls: [],
        messages: [],
      };
    }

    /** @type {Record<string, {from:string, toPort:number}[]>} */
    const incoming = Object.create(null);
    /** @type {Record<string, string[]>} */
    const outgoing = Object.create(null);
    for (const n of nodes) {
      incoming[n.id] = [];
      outgoing[n.id] = [];
    }
    for (const e of edges) {
      if (!byId[e.from] || !byId[e.to]) continue;
      incoming[e.to].push({ from: e.from, toPort: e.toPort == null ? 0 : e.toPort });
      outgoing[e.from].push(e.to);
    }
    for (const id of Object.keys(incoming)) {
      incoming[id].sort((a, b) => a.toPort - b.toPort);
    }

    // Reachable from entry
    const reachable = new Set();
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const to of outgoing[id] || []) stack.push(to);
    }

    // Kahn topo on reachable subgraph
    const indeg = Object.create(null);
    for (const id of reachable) indeg[id] = 0;
    for (const id of reachable) {
      for (const to of outgoing[id] || []) {
        if (reachable.has(to)) indeg[to] = (indeg[to] || 0) + 1;
      }
    }
    const queue = [];
    for (const id of reachable) {
      if ((indeg[id] || 0) === 0) queue.push(id);
    }
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const to of outgoing[id] || []) {
        if (!reachable.has(to)) continue;
        indeg[to] -= 1;
        if (indeg[to] === 0) queue.push(to);
      }
    }
    if (order.length !== reachable.size) {
      return {
        ok: false,
        error: "Cycle in function graph",
        values: {},
        writes: {},
        rolls: [],
        messages: [],
      };
    }

    /** @type {Record<string, number>} */
    const values = Object.create(null);
    /** @type {Record<string, number>} */
    const writes = Object.create(null);
    /** @type {{ sides: number, result: number, nodeId: string }[]} */
    const rolls = [];
    /** @type {{ text: string, value: number, detail?: string, nodeId: string }[]} */
    const messages = [];
    const env = fieldEnv && typeof fieldEnv === "object" ? fieldEnv : {};

    function inputVal(nodeId, port) {
      const ins = incoming[nodeId] || [];
      const hit = ins.find((x) => x.toPort === port) || ins[port];
      if (!hit) return 0;
      const v = values[hit.from];
      return Number.isFinite(v) ? v : 0;
    }

    try {
      for (const id of order) {
        const n = byId[id];
        if (!n) continue;
        let out = 0;
        if (n.kind === "entry" || n.kind === "function") {
          out = 1;
        } else if (n.kind === "const") {
          const v = Number(n.value);
          out = Number.isFinite(v) ? v : 0;
        } else if (n.kind === "roll") {
          const sides = Math.max(2, Math.floor(Number(n.sides) || 20));
          out = rollDie(sides);
          rolls.push({ sides, result: out, nodeId: id });
        } else if (n.kind === "field") {
          const fname = String(n.field || "").trim();
          if (n.role === "output") {
            out = inputVal(id, 0);
            if (fname) writes[fname] = out;
          } else {
            const raw = env[fname];
            const num = typeof raw === "number" ? raw : Number(raw);
            out = Number.isFinite(num) ? num : 0;
          }
        } else if (n.kind === "op") {
          const op = n.op;
          if (op === "floor") {
            out = Math.floor(inputVal(id, 0));
          } else if (op === "+" || op === "-" || op === "*" || op === "/") {
            const a = inputVal(id, 0);
            const b = inputVal(id, 1);
            if (op === "+") out = a + b;
            else if (op === "-") out = a - b;
            else if (op === "*") out = a * b;
            else out = b === 0 ? NaN : a / b;
            if (!Number.isFinite(out)) out = 0;
          } else {
            throw new Error(`Unknown op: ${op}`);
          }
        } else if (n.kind === "send_to_chat" || n.kind === "chat") {
          out = inputVal(id, 0);
          const text = n.label != null ? String(n.label).trim() : "";
          let detail = "";
          const ins = incoming[id] || [];
          const hit = ins.find((x) => x.toPort === 0) || ins[0];
          if (hit) {
            const roll = rolls.find((r) => r.nodeId === hit.from);
            if (roll) detail = `d${roll.sides}`;
          }
          const msg = { text, value: out, nodeId: id };
          if (detail) msg.detail = detail;
          messages.push(msg);
        } else {
          throw new Error(`Unknown node kind: ${n.kind}`);
        }
        values[id] = out;
      }
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : String(err),
        values,
        writes,
        rolls,
        messages,
      };
    }

    return { ok: true, values, writes, rolls, messages };
  }

  const api = {
    evalClosedFormula,
    rollDie,
    arityOf,
    evaluateNamedFunction,
  };

  global.SheetRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
