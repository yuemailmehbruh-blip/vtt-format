/**
 * Shared sheet automation runtime (session sheet + optional tooling).
 * Closed formulas + named-function DAG evaluation (entry / roll / send_to_chat / field / op / const).
 * Logic ops: == != < > <= >= and or not if; entryValue option for toggle 0/1.
 * Reachability: forward BFS from entry, then close under incoming ancestors before Kahn topo.
 * Templates: entry names with [x] match function_id prefix+ID+suffix or prefix+[ID]+suffix;
 * reachable subgraph is deep-cloned and [x] substituted before eval.
 * compileGraph: closed formulas from output fields; formula macros = collapsed
 * groups with no entry expand [x] templates against existing field ids.
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

  const TEMPLATE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /**
   * Extract ID from call given template prefix/suffix (exactly one [x] slot).
   * Accepts call === prefix+ID+suffix or prefix+"["+ID+"]"+suffix.
   * @returns {string|null}
   */
  function extractTemplateId(call, prefix, suffix) {
    const c = String(call || "");
    const p = String(prefix || "");
    const s = String(suffix || "");
    if (!c.startsWith(p)) return null;
    if (s) {
      if (!c.endsWith(s)) return null;
    }
    const mid = c.slice(p.length, c.length - s.length);
    if (!mid) return null;
    if (mid.startsWith("[") && mid.endsWith("]") && mid.length >= 3) {
      const inner = mid.slice(1, -1);
      return TEMPLATE_ID_RE.test(inner) ? inner : null;
    }
    return TEMPLATE_ID_RE.test(mid) ? mid : null;
  }

  /**
   * Resolve function_id to an entry node, optionally via [x] template.
   * @returns {{ entry: object, substId: string|null } | { error: string }}
   */
  function resolveNamedEntry(nodes, functionId) {
    const name = String(functionId || "").trim();
    if (!name) return { error: "Missing function id" };

    const entries = (nodes || []).filter(
      (n) => n && (n.kind === "entry" || n.kind === "function")
    );

    const exact = entries.find((n) => String(n.name || "").trim() === name);
    if (exact) {
      const ename = String(exact.name || "").trim();
      if (ename.includes("[x]")) {
        const hintPlain = ename.split("[x]").join("ID");
        const hintBrackets = ename.split("[x]").join("[ID]");
        return {
          error:
            `Template "${ename}" needs an ID — use a button with function_id like ${hintPlain} or ${hintBrackets}`,
        };
      }
      return { entry: exact, substId: null };
    }

    /** @type {{ entry: object, substId: string, tmpl: string }[]} */
    const matches = [];
    for (const e of entries) {
      const tmpl = String(e.name || "").trim();
      if (!tmpl.includes("[x]")) continue;
      const parts = tmpl.split("[x]");
      if (parts.length !== 2) continue; // v1: exactly one [x]
      const id = extractTemplateId(name, parts[0], parts[1]);
      if (id) matches.push({ entry: e, substId: id, tmpl });
    }
    if (!matches.length) {
      return { error: `No entry function named "${name}"` };
    }
    matches.sort((a, b) => b.tmpl.length - a.tmpl.length);
    if (
      matches.length >= 2 &&
      matches[0].tmpl.length === matches[1].tmpl.length
    ) {
      return {
        error: `Ambiguous template match for "${name}" (${matches[0].tmpl} vs ${matches[1].tmpl})`,
      };
    }
    return { entry: matches[0].entry, substId: matches[0].substId };
  }

  /** Replace literal [x] in every string property except id. */
  function substituteXInNode(node, id) {
    const out = {};
    for (const [k, v] of Object.entries(node || {})) {
      if (k === "id") {
        out[k] = v;
      } else if (typeof v === "string") {
        out[k] = v.split("[x]").join(id);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * Evaluate a named automation starting at an entry (or function) node.
   * Supports [x] parameterized templates: entry name check_[x] matches
   * function_id check_ATK or check_[ATK]; reachable subgraph is cloned and
   * every string prop's literal [x] is replaced with the ID before eval.
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
    let nodes = (graph && graph.nodes) || [];
    let edges = (graph && graph.edges) || [];
    if (!name) {
      return { ok: false, error: "Missing function id", values: {}, writes: {}, rolls: [], messages: [] };
    }

    const resolved = resolveNamedEntry(nodes, name);
    if (resolved.error) {
      return {
        ok: false,
        error: resolved.error,
        values: {},
        writes: {},
        rolls: [],
        messages: [],
      };
    }
    let entry = resolved.entry;
    const substId = resolved.substId;

    // Template: clone reachable subgraph, substitute [x] → ID (do not mutate stored graph).
    if (substId) {
      const byId0 = Object.create(null);
      for (const n of nodes) byId0[n.id] = n;
      /** @type {Record<string, string[]>} */
      const outgoing0 = Object.create(null);
      /** @type {Record<string, {from:string}[]>} */
      const incoming0 = Object.create(null);
      for (const n of nodes) {
        outgoing0[n.id] = [];
        incoming0[n.id] = [];
      }
      for (const e of edges) {
        if (!byId0[e.from] || !byId0[e.to]) continue;
        outgoing0[e.from].push(e.to);
        incoming0[e.to].push({ from: e.from });
      }
      const reachable0 = new Set();
      const stack0 = [entry.id];
      while (stack0.length) {
        const id = stack0.pop();
        if (reachable0.has(id)) continue;
        reachable0.add(id);
        for (const to of outgoing0[id] || []) stack0.push(to);
      }
      let grew0 = true;
      while (grew0) {
        grew0 = false;
        for (const id of [...reachable0]) {
          for (const inc of incoming0[id] || []) {
            if (!reachable0.has(inc.from)) {
              reachable0.add(inc.from);
              grew0 = true;
            }
          }
        }
      }
      nodes = nodes
        .filter((n) => reachable0.has(n.id))
        .map((n) => substituteXInNode(n, substId));
      edges = edges
        .filter((e) => reachable0.has(e.from) && reachable0.has(e.to))
        .map((e) => ({ ...e }));
      entry = nodes.find((n) => n.id === entry.id);
      if (!entry) {
        return {
          ok: false,
          error: `Template instantiation failed for "${name}"`,
          values: {},
          writes: {},
          rolls: [],
          messages: [],
        };
      }
    }

    const byId = Object.create(null);
    for (const n of nodes) byId[n.id] = n;

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

    /**
     * Active arithmetic path for chat detail (not the full logic tree).
     * if → taken branch only; compare/and/or/not → bare 1/0; + - * / floor expand.
     */
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
        // Logic/compare: never dump the condition tree into arithmetic detail
        if (
          op === "not" ||
          op === "and" ||
          op === "or" ||
          op === "==" ||
          op === "!=" ||
          op === "<" ||
          op === ">" ||
          op === "<=" ||
          op === ">="
        ) {
          return String(num);
        }
        // if: unwrap to the branch that produced the value (cond / untaken omitted)
        if (op === "if") {
          const condId = inFrom(nodeId, 0);
          const condV =
            condId != null && Number.isFinite(values[condId]) ? values[condId] : 0;
          const taken = isTruthyNum(condV)
            ? inFrom(nodeId, 1)
            : inFrom(nodeId, 2);
          return formatArithmetic(taken, parentOp);
        }
        if (op === "+" || op === "-" || op === "*" || op === "/") {
          const expr = `${formatArithmetic(inFrom(nodeId, 0), op)} ${op} ${formatArithmetic(inFrom(nodeId, 1), op)}`;
          const needParen =
            parentOp &&
            ((parentOp === "*" || parentOp === "/") && (op === "+" || op === "-"));
          return needParen ? `(${expr})` : expr;
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

  function isValidCompileName(id) {
    const s = String(id || "").trim();
    if (!s) return false;
    const collapsed = s.split("[x]").join("x");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(collapsed);
  }

  /**
   * Bind concrete field F to template containing [x] (same ID in every slot).
   * @returns {string|null} ID or null
   */
  function bindMacroId(template, fieldId) {
    const tmpl = String(template || "").trim();
    const F = String(fieldId || "").trim();
    if (!tmpl || !F || !tmpl.includes("[x]")) return null;
    const parts = tmpl.split("[x]");
    if (parts.length < 2) return null;
    if (parts.length === 2) {
      const pre = parts[0];
      const suf = parts[1];
      if (!F.startsWith(pre)) return null;
      if (suf) {
        if (!F.endsWith(suf)) return null;
      } else if (pre && F === pre) {
        return null;
      }
      const id = F.slice(pre.length, F.length - suf.length);
      if (!TEMPLATE_ID_RE.test(id)) return null;
      if (tmpl.split("[x]").join(id) !== F) return null;
      return id;
    }
    // Multiple [x]: derive from first gap between fixed parts, verify full expand.
    const pre = parts[0];
    if (!F.startsWith(pre)) return null;
    let rest = F.slice(pre.length);
    // Greedy: take identifier prefix as ID, then verify
    const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m) return null;
    // Try longest-then-shorter valid IDs that fully reconstruct
    for (let len = m[1].length; len >= 1; len--) {
      const id = m[1].slice(0, len);
      if (!TEMPLATE_ID_RE.test(id)) continue;
      if (tmpl.split("[x]").join(id) === F) return id;
    }
    return null;
  }

  function collectFieldKeys(graph, fieldsOrKeys) {
    const keys = new Set();
    if (Array.isArray(fieldsOrKeys)) {
      for (const k of fieldsOrKeys) if (k != null && String(k).trim()) keys.add(String(k).trim());
    } else if (fieldsOrKeys && typeof fieldsOrKeys === "object") {
      for (const k of Object.keys(fieldsOrKeys)) keys.add(k);
    }
    for (const n of (graph && graph.nodes) || []) {
      if (n && n.kind === "field" && n.field != null) {
        const f = String(n.field).trim();
        if (f && !f.includes("[x]")) keys.add(f);
      }
    }
    return [...keys];
  }

  /**
   * Compile automation graph into closed formulas for output field nodes.
   * Formula macros: collapsed groups with no entry/function expand [x] templates
   * against existing field ids (e.g. [x]_mod + STR_mod → ID=STR).
   * @param {{ nodes?: object[], edges?: object[], collapsed?: object[] }} graph
   * @param {Record<string, unknown>|string[]} [fieldsOrKeys]
   * @returns {{ formulas: Record<string,string>, error?: string }}
   */
  function compileGraph(graph, fieldsOrKeys) {
    const nodes = (graph && graph.nodes) || [];
    const edges = (graph && graph.edges) || [];
    const byId = Object.create(null);
    for (const n of nodes) byId[n.id] = n;

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

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = Object.create(null);
    for (const n of nodes) color[n.id] = WHITE;
    function hasCycleFrom(id) {
      color[id] = GRAY;
      for (const to of outgoing[id] || []) {
        if (color[to] === GRAY) return true;
        if (color[to] === WHITE && hasCycleFrom(to)) return true;
      }
      color[id] = BLACK;
      return false;
    }
    for (const n of nodes) {
      if (color[n.id] === WHITE && hasCycleFrom(n.id)) {
        return { formulas: {}, error: "Cycle detected in automation graph" };
      }
    }

    function exprOfOn(byIdLocal, incomingLocal, nodeId, memo, visiting) {
      if (memo[nodeId] != null) return memo[nodeId];
      if (visiting[nodeId]) throw new Error("Cycle while compiling");
      visiting[nodeId] = true;
      const n = byIdLocal[nodeId];
      if (!n) throw new Error(`Missing node ${nodeId}`);
      let out;
      if (n.kind === "field") {
        const fname = String(n.field || "").trim();
        if (!isValidCompileName(fname)) {
          throw new Error(`Invalid field name on node ${nodeId}`);
        }
        if (n.role === "output") {
          const ins = incomingLocal[nodeId] || [];
          if (ins.length !== 1) {
            throw new Error(`Output field "${fname}" needs exactly one input wire`);
          }
          out = exprOfOn(byIdLocal, incomingLocal, ins[0].from, memo, visiting);
        } else {
          out = fname;
        }
      } else if (n.kind === "const") {
        const v = Number(n.value);
        if (!Number.isFinite(v)) throw new Error(`Bad constant on ${nodeId}`);
        out = String(v);
      } else if (n.kind === "op") {
        const op = n.op;
        const ins = incomingLocal[nodeId] || [];
        function portFrom(port, fallbackIdx) {
          return ins.find((x) => x.toPort === port) || ins[fallbackIdx];
        }
        if (op === "floor" || op === "not") {
          if (ins.length < 1) throw new Error(`${op} needs one input`);
          const a = portFrom(0, 0);
          out = `${op}(${exprOfOn(byIdLocal, incomingLocal, a.from, memo, visiting)})`;
        } else if (op === "if") {
          if (ins.length < 3) throw new Error("if needs three inputs (cond, then, else)");
          const c = portFrom(0, 0);
          const t = portFrom(1, 1);
          const e = portFrom(2, 2);
          out = `if(${exprOfOn(byIdLocal, incomingLocal, c.from, memo, visiting)}, ${exprOfOn(byIdLocal, incomingLocal, t.from, memo, visiting)}, ${exprOfOn(byIdLocal, incomingLocal, e.from, memo, visiting)})`;
        } else if (op === "and" || op === "or") {
          if (ins.length < 2) throw new Error(`${op} needs two inputs`);
          const a = portFrom(0, 0);
          const b = portFrom(1, 1);
          out = `${op}(${exprOfOn(byIdLocal, incomingLocal, a.from, memo, visiting)}, ${exprOfOn(byIdLocal, incomingLocal, b.from, memo, visiting)})`;
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
          if (ins.length < 2) throw new Error(`Operator ${op} needs two inputs`);
          const a = portFrom(0, 0);
          const b = portFrom(1, 1);
          out = `(${exprOfOn(byIdLocal, incomingLocal, a.from, memo, visiting)} ${op} ${exprOfOn(byIdLocal, incomingLocal, b.from, memo, visiting)})`;
        } else {
          throw new Error(`Unknown op: ${op}`);
        }
      } else if (
        n.kind === "roll" ||
        n.kind === "entry" ||
        n.kind === "function" ||
        n.kind === "send_to_chat" ||
        n.kind === "chat"
      ) {
        throw new Error(
          "Roll/entry/chat nodes are runtime-only and cannot feed formula field outputs"
        );
      } else {
        throw new Error(`Unknown node kind: ${n.kind}`);
      }
      visiting[nodeId] = false;
      memo[nodeId] = out;
      return out;
    }

    const formulas = {};
    const memo = Object.create(null);
    const visiting = Object.create(null);
    try {
      for (const n of nodes) {
        if (n.kind === "field" && n.role === "output") {
          const fname = String(n.field || "").trim();
          if (fname.includes("[x]")) continue; // template / macro placeholders
          formulas[fname] = exprOfOn(byId, incoming, n.id, memo, visiting);
        }
      }
    } catch (err) {
      return { formulas: {}, error: err.message || String(err) };
    }

    // Formula macros: collapsed groups with no entry/function
    const fieldKeys = collectFieldKeys(graph, fieldsOrKeys);
    /** @type {Record<string, string>} */
    const claimedBy = Object.create(null);

    for (const block of (graph && graph.collapsed) || []) {
      if (!block || !Array.isArray(block.nodeIds) || !block.nodeIds.length) continue;
      const memberSet = new Set(block.nodeIds.map(String));
      const members = nodes.filter((n) => memberSet.has(n.id));
      const hasEntry = members.some(
        (n) => n.kind === "entry" || n.kind === "function"
      );
      if (hasEntry) continue;

      const blockLabel = block.name != null && String(block.name).trim()
        ? String(block.name).trim()
        : String(block.id || "macro");

      const outNodes = members.filter(
        (n) => n.kind === "field" && n.role === "output"
      );
      if (!outNodes.length) continue;

      for (const outNode of outNodes) {
        const tmpl = String(outNode.field || "").trim();
        if (!tmpl.includes("[x]")) continue;

        for (const F of fieldKeys) {
          const id = bindMacroId(tmpl, F);
          if (!id) continue;
          if (!TEMPLATE_ID_RE.test(id)) continue;

          if (claimedBy[F] && claimedBy[F] !== blockLabel) {
            return {
              formulas: {},
              error: `Formula macros "${claimedBy[F]}" and "${blockLabel}" both claim field ${F}`,
            };
          }
          claimedBy[F] = blockLabel;

          const subNodes = members.map((n) => substituteXInNode(n, id));
          const subById = Object.create(null);
          for (const n of subNodes) subById[n.id] = n;
          const subIncoming = Object.create(null);
          for (const n of subNodes) subIncoming[n.id] = [];
          for (const e of edges) {
            if (!memberSet.has(e.from) || !memberSet.has(e.to)) continue;
            if (!subById[e.from] || !subById[e.to]) continue;
            subIncoming[e.to].push({
              from: e.from,
              toPort: e.toPort == null ? 0 : e.toPort,
            });
          }
          for (const sid of Object.keys(subIncoming)) {
            subIncoming[sid].sort((a, b) => a.toPort - b.toPort);
          }

          try {
            const formula = exprOfOn(
              subById,
              subIncoming,
              outNode.id,
              Object.create(null),
              Object.create(null)
            );
            formulas[F] = formula;
          } catch (err) {
            return {
              formulas: {},
              error:
                `Formula macro "${blockLabel}" failed for ${F} (ID=${id}): ` +
                (err.message || String(err)),
            };
          }
        }
      }
    }

    return { formulas };
  }

  const api = {
    evalClosedFormula,
    rollDie,
    arityOf,
    evaluateNamedFunction,
    resolveNamedEntry,
    extractTemplateId,
    compileGraph,
    bindMacroId,
  };

  global.SheetRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
