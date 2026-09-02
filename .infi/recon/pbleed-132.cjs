const fs = require("fs");
const src = fs.readFileSync(require("path").resolve(__dirname, "../../frontend/src/main.jsx"), "utf8");

// Strips FULL-LINE and TRAILING `//` comments. Trailing matters: P5 plants the expected
// guard text in a trailing comment beside de-guarded code, and a `^\s*//` strip leaves it.
// A `//` inside a string literal would be mangled, so the caller asserts there are none in
// this file rather than pretending the strip is a parser.
function stripLineComments(s) {
  return s
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

// Brace-balanced. No text delimiter anywhere: walk back from the path literal to the `{` that
// opens its object, then forward to the matching `}`. Every failure returns an error string
// rather than a degraded slice.
function block(source, path) {
  const at = source.indexOf(JSON.stringify(path));
  if (at < 0) return { err: "path literal not found" };
  let dep = 0, st = -1;
  for (let i = at; i >= 0; i--) {
    const c = source[i];
    if (c === "}") dep++;
    else if (c === "{") { if (dep === 0) { st = i; break; } dep--; }
  }
  if (st < 0) return { err: "no enclosing brace" };
  let d = 0, en = -1;
  for (let i = st; i < source.length; i++) {
    const c = source[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { en = i + 1; break; } }
  }
  if (en < 0) return { err: "unbalanced braces" };
  return { text: source.slice(st, en) };
}

function newCheck(source) {
  const b = block(source, "/settings/mobile-connections");
  if (b.err) return "RED(" + b.err + ")";
  const code = stripLineComments(b.text);
  if ((code.match(/path: "/g) || []).length !== 1) return "RED(block spans >1 route)";
  if (!/SystemReadRoute Component=\{MobileConnections\}/.test(code)) return "RED(guard)";
  if (/\b(AdminRoute|ManagerRoute)\b/.test(code)) return "RED(old guard)";
  return "GREEN";
}

const fixed = src.replace(
  "<AdminRoute Component={MobileConnections} />",
  "<SystemReadRoute Component={MobileConnections} />"
);

const cases = [
  ["baseline post-fix", fixed],
  ["P1 de-guarded", fixed.replace("<SystemReadRoute Component={MobileConnections} />", "<MobileConnections />")],
  ["P2 reverted to AdminRoute", fixed.replace("SystemReadRoute Component={MobileConnections}", "AdminRoute Component={MobileConnections}")],
  ["P3 delimiter/indent reflow", fixed.replace(/\},\n      \{/g, "},\n  {")],
  ["P4 de-guard + text planted below",
    fixed
      .replace("<SystemReadRoute Component={MobileConnections} />", "<MobileConnections />")
      .replace('path: "/settings/scheduled-jobs"', '// SystemReadRoute Component={MobileConnections}\n        path: "/settings/scheduled-jobs"')],
  ["P5 de-guard + comment inside block",
    fixed.replace("<SystemReadRoute Component={MobileConnections} />", "<MobileConnections /> // SystemReadRoute Component={MobileConnections}")],
  ["P6 route path renamed away", fixed.replace('path: "/settings/mobile-connections",', 'path: "/settings/gone",')],
  ["P7 whole route block deleted", fixed.replace(block(fixed, "/settings/mobile-connections").text, "")],
];

for (const [name, source] of cases) {
  console.log(name.padEnd(34) + newCheck(source));
}
