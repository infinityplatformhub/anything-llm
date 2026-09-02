// For each sidebar entry's page: which server routes it ACTUALLY calls, and the MOUNTED
// requirePermission action on each.
//
// A transitive import walk was the first attempt and it was wrong: importing
// `@/models/system` reaches every method on System, so a page making three calls reported
// 58. Instead — find the model objects the page imports, find which METHODS of those the
// page names (`System.foo(`), and take fetch literals from inside those method bodies only.
const fs = require("fs");
const path = require("path");
const resolved = require("/tmp/v8base/resolved.json");
const audit = require("/tmp/v8base/audit-clean.json");

const FE = "/Users/jintawattuitemwong/Documents/GitHub/anything-llm/.claude/worktrees/t5slice2/frontend";
const SRC = path.join(FE, "src");
const mounted = audit.routes;

function findMounted(urlPath) {
  const clean = urlPath.split("?")[0].replace(/\/+$/, "") || "/";
  const exact = mounted.filter((r) => r.path === clean);
  if (exact.length) return exact;
  const segs = clean.split("/");
  return mounted.filter((r) => {
    const rs = r.path.split("/");
    if (rs.length !== segs.length) return false;
    return rs.every((s, i) => s.startsWith(":") || s === segs[i]);
  });
}

const fileCache = {};
function read(p) {
  if (!(p in fileCache)) fileCache[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  return fileCache[p];
}
function resolveModule(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [base, base + ".js", base + ".jsx", path.join(base, "index.js"), path.join(base, "index.jsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// Model methods appear in BOTH forms in this codebase:
//   getDevices: async function () { ... }     (models/mobile.js:30)
//   keys: async () => { ... }
// An arrow-only matcher silently returned null for every `async function` method, which
// surfaced as "this page makes 0 calls" for 12 entries — including mobile-app, which is
// known to call two system.read routes. Zero is the answer a broken extractor gives, so it
// is reported as `unresolved`, never folded into the table as a real zero.
function methodBody(src, name) {
  const at = src.search(new RegExp("\\b" + name + "\\s*:\\s*(?:async\\s*)?(?:function\\s*)?\\("));
  if (at < 0) return null;
  // The body opens at the first `{` after the parameter list — for an arrow, after `=>`.
  const close = src.indexOf(")", at);
  if (close < 0) return null;
  const arrow = src.slice(close, close + 8).indexOf("=>");
  const from = arrow >= 0 ? close + arrow + 2 : close;
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function urlsIn(text) {
  return [...text.matchAll(/\$\{API_BASE\}([^\s`"']*)/g)].map((m) => m[1]);
}

// Walk the page and the LOCAL components it renders. A settings page frequently holds no
// call of its own and delegates to a child (Interface/Branding/Chat -> ../components/*),
// so a page-only scan reports zero and the zero looks like a finding. Depth-limited to 3
// and confined to files under src/, so this cannot wander into node_modules.
function pageCalls(pageFile, depth = 0, seen = new Set(), acc = null) {
  const state = acc || { calls: [], unresolved: [], models: new Set(), indirect: [] };
  if (!pageFile || depth > 3 || seen.has(pageFile)) return state;
  seen.add(pageFile);
  const src = read(pageFile);
  if (!src) return state;

  const models = {};
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveModule(m[2], pageFile);
    if (!target) continue;
    if (target.includes("/models/")) {
      models[m[1]] = target;
      state.models.add(path.basename(target));
    }
  }

  // `const Model = cond ? Admin : System; Model.getApiKeys()` — the object is chosen at
  // runtime, so the method cannot be attributed to one model statically. Recorded rather
  // than dropped: ApiKeys/index.jsx:26 is exactly this shape.
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*[^;]*\?\s*(\w+)\s*:\s*(\w+)\s*;/g)) {
    const [, alias, a, b] = m;
    for (const target of [a, b]) {
      if (!models[target]) continue;
      const modelSrc = read(models[target]);
      if (!modelSrc) continue;
      for (const call of src.matchAll(new RegExp("\\b" + alias + "\\.(\\w+)\\s*\\(", "g"))) {
        const body = methodBody(modelSrc, call[1]);
        if (body === null) { state.unresolved.push(target + "." + call[1]); continue; }
        state.indirect.push(alias + " -> " + target + "." + call[1]);
        state.calls.push(...urlsIn(body));
      }
    }
  }

  for (const [local, file] of Object.entries(models)) {
    const modelSrc = read(file);
    if (!modelSrc) continue;
    for (const m of src.matchAll(new RegExp("\\b" + local + "\\.(\\w+)\\s*\\(", "g"))) {
      const body = methodBody(modelSrc, m[1]);
      if (body === null) { state.unresolved.push(local + "." + m[1]); continue; }
      state.calls.push(...urlsIn(body));
    }
  }
  state.calls.push(...urlsIn(src)); // inline fetches

  // follow local components/hooks
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const target = resolveModule(m[1], pageFile);
    if (!target || target.includes("/models/")) continue;
    if (!target.startsWith(SRC)) continue;
    if (/\/(components|hooks|pages)\//.test(target) || target.startsWith(path.dirname(pageFile)))
      pageCalls(target, depth + 1, seen, state);
  }
  return state;
}

const out = [];
for (const e of resolved) {
  const pageFile = e.page ? resolveModule(e.page, path.join(SRC, "main.jsx")) : null;
  const pcRaw = pageFile ? pageCalls(pageFile) : { calls: [], unresolved: [], models: new Set(), indirect: [] };
  const pc = { ...pcRaw, models: [...pcRaw.models], unresolved: [...new Set(pcRaw.unresolved)], indirect: [...new Set(pcRaw.indirect)] };
  const calls = [...new Set(pc.calls.map((u) => u.replace(/\$\{[^}]+\}/g, ":param")).filter((u) => u.startsWith("/")))];
  const hits = [];
  for (const c of calls) {
    const ms = findMounted(c);
    if (!ms.length) hits.push({ call: c, path: null, methods: [], actions: [], note: "no mounted route" });
    for (const r of ms) hits.push({ call: c, path: r.path, methods: r.methods, actions: r.actions });
  }
  out.push({
    btn: e.btn, href: e.href, guard: e.guard,
    pageFile: pageFile ? path.relative(SRC, pageFile) : null,
    roles: e.roles, capability: e.capability, capabilities: e.capabilities,
    models: pc.models, calls, unresolved: pc.unresolved, indirect: pc.indirect, hits,
  });
}
console.log(JSON.stringify(out, null, 1));
