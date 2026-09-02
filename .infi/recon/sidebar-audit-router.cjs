/**
 * Sidebar entry -> route action audit. MEASURES, does not read.
 *
 * Two halves:
 *  1. Mount the real router and enumerate every route layer, recording the
 *     requirePermission action from the MOUNTED middleware (`.action`, set at
 *     requirePermission.js:104) — not from grepping source.
 *  2. Parse SettingsSidebar/index.jsx for every entry: its btnText, its href
 *     expression, and the capability it gates on.
 *
 * Wrapped gates (gateUnlessPreUser at system.js:413) are invisible to a
 * middleware walk because the gate is CONSTRUCTED inside a plain function at
 * request time. Those are detected separately by scanning endpoint sources for
 * requirePermission calls that are not top-level array elements, and reported
 * as a distinct class rather than silently missed.
 */
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sbaudit-"));
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "sidebar-audit-api-key-pepper-32-bytes-min";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(32);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(32);

const fs = require("fs");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "/Users/jintawattuitemwong/Documents/GitHub/anything-llm/.claude/worktrees/t5slice2/server");
const FRONTEND_DIR = path.resolve(SERVER_DIR, "../frontend");

// ---------- half 1: the mounted router ----------
const { app } = require(path.join(SERVER_DIR, "index.js"));
const {
  isPermissionGate,
} = require(path.join(SERVER_DIR, "utils/middleware/requirePermission.js"));

function layers(stack) {
  return (stack || []).flatMap((l) => [
    ...(l.route ? [l] : []),
    ...layers(l.handle?.stack),
  ]);
}

const routes = [];
for (const layer of layers(app._router?.stack)) {
  const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
  const gates = layer.route.stack
    .map((s) => s.handle)
    .filter((h) => isPermissionGate(h))
    .map((h) => h.action);
  routes.push({ path: layer.route.path, methods, actions: [...new Set(gates)] });
}
if (routes.length === 0) {
  console.error("EXTRACTION FAILED: router produced zero routes");
  process.exit(2);
}

// ---------- half 1b: gates constructed at request time ----------
// requirePermission(...) appearing inside a function body rather than in the
// middleware array. A router walk cannot see these: the middleware does not
// exist until the request arrives.
const wrapped = [];
const endpointDir = path.join(SERVER_DIR, "endpoints");
function walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p);
    else if (e.name.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/return requirePermission\(/.test(line)) return;
        wrapped.push({
          file: path.relative(SERVER_DIR, p),
          line: i + 1,
          action: (line.match(/requirePermission\("([^"]+)"/) || [])[1] ?? "(dynamic)",
        });
      });
    }
  }
}
walkFiles(endpointDir);

// ---------- half 2: the sidebar ----------
const sidebarPath = path.join(FRONTEND_DIR, "src/components/SettingsSidebar/index.jsx");
const sidebar = fs.readFileSync(sidebarPath, "utf8");

// Entries are object literals with btnText + href + optional capability. Parse
// by brace-balancing from each `btnText` so a nested object cannot bleed.
function entryAt(src, at) {
  let dep = 0, st = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === "}") dep++;
    else if (c === "{") { if (dep === 0) { st = i; break; } dep--; }
  }
  if (st < 0) return null;
  let d = 0, en = -1;
  for (let i = st; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { en = i + 1; break; } }
  }
  if (en < 0) return null;
  return src.slice(st, en);
}

const entries = [];
const seen = new Set();
for (const m of sidebar.matchAll(/btnText[=:]/g)) {
  const block = entryAt(sidebar, m.index);
  if (!block) continue;
  if (seen.has(m.index)) continue;
  seen.add(m.index);
  const btn = (block.match(/btnText[=:]\s*\{?\s*(?:t\(\s*)?["'`]([^"'`]+)/) || [])[1] ?? "(dynamic)";
  const href = (block.match(/href[=:]\s*\{?\s*paths\.([A-Za-z0-9_.]+)/) || [])[1] ?? null;
  const cap = (block.match(/capability[=:]\s*["']([^"']+)["']/) || [])[1] ?? null;
  const caps = (block.match(/capabilities[=:]\s*\[([^\]]*)\]/) || [])[1];
  const rolesRaw = (block.match(/roles[=:]\s*\[([^\]]*)\]/) || [])[1];
  entries.push({
    btn,
    href,
    capability: cap,
    capabilities: caps ? [...caps.matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null,
    roles: rolesRaw ? [...rolesRaw.matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null,
  });
}
if (entries.length === 0) {
  console.error("EXTRACTION FAILED: no sidebar entries parsed");
  process.exit(2);
}
const gateless = entries.filter((e) => !e.capability && !e.capabilities && !e.roles);
if (gateless.length === entries.length) {
  console.error("EXTRACTION FAILED: no entry carried any gate expression");
  process.exit(2);
}

// ---------- ORG_CAPABILITIES ----------
const sysSrc = fs.readFileSync(path.join(SERVER_DIR, "endpoints/system.js"), "utf8");
const orgMatch = sysSrc.match(/const ORG_CAPABILITIES = \[([\s\S]*?)\];/);
if (!orgMatch) {
  console.error("EXTRACTION FAILED: ORG_CAPABILITIES not found");
  process.exit(2);
}
const ORG = [...orgMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

console.log(JSON.stringify({ routes, wrapped, entries, ORG }, null, 1));
