// Resolve each sidebar entry's href to a client route, then that page's server
// calls, then those calls' MOUNTED requirePermission actions.
const fs = require("fs");
const path = require("path");
const d = require("/tmp/v8base/audit-clean.json");

const FE = "/Users/jintawattuitemwong/Documents/GitHub/anything-llm/.claude/worktrees/t5slice2/frontend";

// Resolve hrefs by EVALUATING paths.js, not by pattern-matching it.
//
// Two regex attempts got this wrong in the same way and it is worth recording: a leaf-name
// match returned `paths.onboarding.llmPreference` for every `paths.settings.llmPreference`
// (both leaves exist), and a namespace-then-leaf match returned `workspace.settings` for
// `settings` (paths.js:86 vs :113 — first match wins). Both produced a full table of
// plausible, wrong routes. The module is a pure data object with no imports, so evaluating
// it is both simpler and exact.
const pathsSrc = fs.readFileSync(path.join(FE, "src/utils/paths.js"), "utf8");
const objStart = pathsSrc.indexOf("export default {");
if (objStart < 0) throw new Error("EXTRACTION FAILED: no default export in paths.js");
let depth = 0, objEnd = -1;
for (let i = pathsSrc.indexOf("{", objStart); i < pathsSrc.length; i++) {
  const c = pathsSrc[i];
  if (c === "{") depth++;
  else if (c === "}") { depth--; if (depth === 0) { objEnd = i + 1; break; } }
}
if (objEnd < 0) throw new Error("EXTRACTION FAILED: unbalanced paths.js default export");
// `import.meta.env` is Vite syntax and is not valid in a plain Function body; the two
// sites that use it are dev-only branches. Substituted with a literal so the object
// evaluates — recorded here because silently rewriting source before measuring it is
// exactly the kind of step that makes a measurement wrong without looking wrong.
const objText = pathsSrc
  .slice(pathsSrc.indexOf("{", objStart), objEnd)
  .replace(/import\.meta\.env\.DEV/g, "false")
  .replace(/import\.meta\.env\.[A-Z_]+/g, '"\u0000"');
const substitutions = (pathsSrc.slice(0, objEnd).match(/import\.meta\.env/g) || []).length;
const PATHS = new Function("return " + objText)();

function resolveHref(expr) {
  if (!expr) return null;
  let node = PATHS;
  for (const part of expr.split(".")) {
    if (node == null || !(part in node)) return { err: "no such path: " + expr };
    node = node[part];
  }
  if (typeof node !== "function") return { err: "not a function: " + expr };
  try {
    // Called with no args: parameterised paths come back with `undefined` interpolated,
    // which is visible in the output rather than silently wrong.
    return String(node());
  } catch (e) {
    return { err: "threw: " + e.message };
  }
}

// client route -> page module, from main.jsx
const mainSrc = fs.readFileSync(path.join(FE, "src/main.jsx"), "utf8");
function routeBlockFor(p) {
  const at = mainSrc.indexOf(JSON.stringify(p));
  if (at < 0) return null;
  let dep = 0, st = -1;
  for (let i = at; i >= 0; i--) {
    const c = mainSrc[i];
    if (c === "}") dep++;
    else if (c === "{") { if (dep === 0) { st = i; break; } dep--; }
  }
  if (st < 0) return null;
  let dd = 0, en = -1;
  for (let i = st; i < mainSrc.length; i++) {
    const c = mainSrc[i];
    if (c === "{") dd++;
    else if (c === "}") { dd--; if (dd === 0) { en = i + 1; break; } }
  }
  return en < 0 ? null : mainSrc.slice(st, en);
}

// page module -> the model methods it calls -> the fetch paths those hit
const modelSrcCache = {};
function readModel(rel) {
  if (!(rel in modelSrcCache)) {
    const p = path.join(FE, "src/models", rel);
    modelSrcCache[rel] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }
  return modelSrcCache[rel];
}

// Server routes, mounted: path -> {methods, actions}
const byPath = new Map();
for (const r of d.routes) byPath.set(r.path, r);

const out = [];
for (const e of d.entries) {
  const r = resolveHref(e.href);
  const href = typeof r === "string" ? r : null;
  const hrefErr = typeof r === "string" ? null : (r && r.err) || "unresolved";
  const block = href ? routeBlockFor(href) : null;
  const guard = block ? (block.match(/<(\w*Route)\s/) || [])[1] ?? null : null;
  const page = block ? (block.match(/import\(\s*"([^"]+)"/) || [])[1] ?? null : null;
  out.push({
    btn: e.btn,
    hrefExpr: e.href,
    href,
    hrefErr,
    guard,
    page,
    roles: e.roles,
    capability: e.capability,
    capabilities: e.capabilities,
  });
}
console.error("import.meta.env substitutions: " + substitutions);
console.log(JSON.stringify(out, null, 1));
