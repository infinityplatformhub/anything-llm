// Third invisible-gate class: routes that authorize INSIDE the handler body.
// `/system/api-keys` (system.js:1626) does `if (response.locals.multiUserMode) return 401`.
// A middleware walk sees only [validatedRequest] and would report it ungated — which would
// be a false finding, not a conservative one.
const fs = require("fs");
const path = require("path");
const S = "/Users/jintawattuitemwong/Documents/GitHub/anything-llm/.claude/worktrees/t5slice2/server";

const PATTERNS = [
  ["multiUserMode-in-handler", /locals\.multiUserMode/],
  ["role-string-in-handler", /locals\.user\?\.role|user\.role\s*[!=]==/],
  ["requireSelfSession", /requireSelfSession/],
  ["flexUserRoleValid", /flexUserRoleValid/],
  ["strictMultiUserRoleValid", /strictMultiUserRoleValid/],
];

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(path.join(S, "endpoints"));

const found = {};
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  // locate each app.<verb>("<path>" and scan its handler body for the patterns
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
    const start = m.index;
    let d = 0, end = src.length;
    for (let i = src.indexOf("(", start); i < src.length; i++) {
      const c = src[i];
      if (c === "(") d++;
      else if (c === ")") { d--; if (d === 0) { end = i; break; } }
    }
    const body = src.slice(start, end);
    const hits = PATTERNS.filter(([, re]) => re.test(body)).map(([n]) => n);
    if (hits.length) {
      const line = src.slice(0, start).split("\n").length;
      found[m[2]] = found[m[2]] || [];
      found[m[2]].push({ file: path.relative(S, f), line, method: m[1], gates: hits });
    }
  }
}
console.log(JSON.stringify(found, null, 1));
