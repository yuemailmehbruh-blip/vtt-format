/**
 * Shared sheet automation runtime (session sheet + optional tooling).
 * Closed formulas + named-function DAG evaluation (entry / roll / send_to_chat / field / op / const).
 * Logic ops: == != < > <= >= and or not if; entryValue option for toggle 0/1.
 * Reachability: forward BFS from entry, then close under incoming ancestors before Kahn topo.
 */
(function (global) {
  "use strict";

  /**
   * Closed formula language: identifiers, numbers, + - * /, comparisons,
   * parentheses, floor(...), if(a,b,c), and(a,b), or(a,b), not(a).
   * Precedence: primary/unary → * / → + − → comparisons (== != < > <= >=).
   * and/or/not/if are call-forms only (not infix).
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

    function matchOp(op) {
      peek();
      if (src.slice(i, i + op.length) === op) {
        i += op.length;
        return true;
      }
      return false;
    }

    function truthy(v) {
      return Number.isFinite(v) && v !== 0;
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

    function parseArgList(count) {
      if (!match("(")) throw new Error("expected (");
      const args = [];
      for (let k = 0; k < count; k++) {
        if (k > 0 && !match(",")) throw new Error("expected ,");
        args.push(parseExpr());
      }
      if (!match(")")) throw new Error("expected )");
      return args;
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
          const [v] = parseArgList(1);
          return Math.floor(v);
        }
        if (ident === "if") {
          const [c, t, e] = parseArgList(3);
          return truthy(c) ? t : e;
        }
        if (ident === "and") {
          const [a, b] = parseArgList(2);
          return truthy(a) && truthy(b) ? 1 : 0;
        }
        if (ident === "or") {
          const [a, b] = parseArgList(2);
          return truthy(a) || truthy(b) ? 1 : 0;
        }
        if (ident === "not") {
          const [a] = parseArgList(1);
          return truthy(a) ? 0 : 1;
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

    function parseAdd() {
      let v = parseTerm();
      for (;;) {
        peek();
        if (match("+")) v += parseTerm();
        else if (match("-")) v -= parseTerm();
        else break;
      }
      return v;
    }

    function parseCompare() {
      let v = parseAdd();
      for (;;) {
        peek();
        let op = null;
        if (matchOp("==")) op = "==";
        else if (matchOp("!=")) op = "!=";
        else if (matchOp("<=")) op = "<=";
        else if (matchOp(">=")) op = ">=";
        else if (matchOp("<")) op = "<";
        else if (matchOp(">")) op = ">";
        else break;
        const r = parseAdd();
        if (op === "==") v = v === r ? 1 : 0;
        else if (op === "!=") v = v !== r ? 1 : 0;
        else if (op === "<") v = v < r ? 1 : 0;
        else if (op === ">") v = v > r ? 1 : 0;
        else if (op === "<=") v = v <= r ? 1 : 0;
        else if (op === ">=") v = v >= r ? 1 : 0;
      }
      return v;
    }

    function parseExpr() {
      return parseCompare();
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
      const op = node.op;
      if (op === "floor" || op === "not") return 1;
      if (op === "if") return 3;
      return 2;
    }
    if (node.kind === "field" && node.role === "output") return 1;
    if (node.kind === "roll") return 1;
    if (node.kind === "send_to_chat" || node.kind === "chat") return 1;
    return 0;
  }

  function isTruthyNum(v) {
    return Number.isFinite(v) && v !== 0;
  }

  /**
   * Evaluate a named automation starting at an entry (or function) node.
   * @param {{ nodes?: object[], edges?: object[] }} graph
   * @param {string} functionId
   * @param {Record<string, number|string>} fieldEnv
   * @param {{ entryValue?: number }} [options] — entry/function nodes output this (default 1)
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   values: Record<string, number>,
   *   writes: Record<string, number>,
   *   rolls: { sides: number, result: number, nodeId: string }[],
   *   messages: { text: string, value: number, detail?: string, nodeId: string }[]
   * }}
   */
  function evaluateNamedFunction(graph, functionId, fieldEnv, options) {
    const name = String(functionId || "").trim();
    const opts = options && typeof options === "object" ? options : {};
    const entryValue =
      typeof opts.entryValue === "number" && Number.isFinite(opts.entryValue)
        ? opts.entryValue
        : 1;
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

    // Forward-reachable from entry, then close under ancestors (incoming).
    // Source fields/consts that only feed ops via side wires must run too.
    // Self-check: entry→roll→+←STR, +→send_to_chat must include STR in reachable.
    const reachable = new Set();
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const to of outgoing[id] || []) stack.push(to);
    }
    // Expand: walk incoming edges until closed (ancestors of forward set).
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...reachable]) {
        for (const inc of incoming[id] || []) {
          if (!reachable.has(inc.from)) {
            reachable.add(inc.from);
            grew = true;
          }
        }
      }
    }

    // Kahn topo on expanded reachable subgraph
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

    function inFrom(nodeId, port) {
      const ins = incoming[nodeId] || [];
      const hit = ins.find((x) => x.toPort === port) || ins[port];
      return hit ? hit.from : null;
    }

    /** Describe a node’s value for chat arithmetic, e.g. `15 (d20) + 10 (STR)`. */
    function formatArithmetic(nodeId, parentOp) {
      if (!nodeId) return "0";
      const n = byId[nodeId];
      if (!n) return "0";
      const v = values[nodeId];
      const num = Number.isFinite(v) ? v : 0;
      if (n.kind === "roll") {
        const sides = Math.max(2, Math.floor(Number(n.sides) || 20));
        return `${num} (d${sides})`;
      }
      if (n.kind === "field") {
        const fname = String(n.field || "").trim() || "field";
        if (n.role === "output") {
          const src = inFrom(nodeId, 0);
          return src ? formatArithmetic(src, parentOp) : `${num} (${fname})`;
        }
        return `${num} (${fname})`;
      }
      if (n.kind === "const") return String(num);
      if (n.kind === "op") {
        const op = n.op;
        if (op === "floor") {
          return `floor(${formatArithmetic(inFrom(nodeId, 0), "floor")})`;
        }
        if (op === "not") {
          return `not(${formatArithmetic(inFrom(nodeId, 0), "not")})`;
        }
        if (op === "if") {
          return `if(${formatArithmetic(inFrom(nodeId, 0), "if")}, ${formatArithmetic(inFrom(nodeId, 1), "if")}, ${formatArithmetic(inFrom(nodeId, 2), "if")})`;
        }
        if (op === "and" || op === "or") {
          return `${op}(${formatArithmetic(inFrom(nodeId, 0), op)}, ${formatArithmetic(inFrom(nodeId, 1), op)})`;
        }
        const compares = { "==": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1 };
        if (op === "+" || op === "-" || op === "*" || op === "/" || compares[op]) {
          const expr = `${formatArithmetic(inFrom(nodeId, 0), op)} ${op} ${formatArithmetic(inFrom(nodeId, 1), op)}`;
          const needParen =
            parentOp &&
            ((parentOp === "*" || parentOp === "/") && (op === "+" || op === "-"));
          const wrapCompare = compares[op] && parentOp && parentOp !== "if" && parentOp !== "and" && parentOp !== "or" && parentOp !== "not" && parentOp !== "floor";
          return needParen || wrapCompare ? `(${expr})` : expr;
        }
      }
      return String(num);
    }

    try {
      for (const id of order) {
        const n = byId[id];
        if (!n) continue;
        let out = 0;
        if (n.kind === "entry" || n.kind === "function") {
          out = entryValue;
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
          } else if (op === "not") {
            out = isTruthyNum(inputVal(id, 0)) ? 0 : 1;
          } else if (op === "if") {
            const cond = inputVal(id, 0);
            out = isTruthyNum(cond) ? inputVal(id, 1) : inputVal(id, 2);
          } else if (op === "and") {
            const a = inputVal(id, 0);
            const b = inputVal(id, 1);
            out = isTruthyNum(a) && isTruthyNum(b) ? 1 : 0;
          } else if (op === "or") {
            const a = inputVal(id, 0);
            const b = inputVal(id, 1);
            out = isTruthyNum(a) || isTruthyNum(b) ? 1 : 0;
          } else if (
            op === "+" ||
            op === "-" ||
            op === "*" ||
            op === "/" ||
            op === "==" ||
            op === "!=" ||
            op === "<" ||
            op === ">" ||
            op === "<=" ||
            op === ">="
          ) {
            const a = inputVal(id, 0);
            const b = inputVal(id, 1);
            if (op === "+") out = a + b;
            else if (op === "-") out = a - b;
            else if (op === "*") out = a * b;
            else if (op === "/") out = b === 0 ? NaN : a / b;
            else if (op === "==") out = a === b ? 1 : 0;
            else if (op === "!=") out = a !== b ? 1 : 0;
            else if (op === "<") out = a < b ? 1 : 0;
            else if (op === ">") out = a > b ? 1 : 0;
            else if (op === "<=") out = a <= b ? 1 : 0;
            else if (op === ">=") out = a >= b ? 1 : 0;
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
          const wantArith = n.include_arithmetic === true;
          if (wantArith && hit) {
            detail = formatArithmetic(hit.from) + " = " + out;
          } else if (hit) {
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
