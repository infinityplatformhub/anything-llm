const fs = require("fs");
const path = require("path");

const { API_KEY_SCOPES } = require("../../../utils/apiKeySecurity/scopes");

// PR-4b(3) ruling (a): the browser extension no longer draws scopes from the API key
// table, so its five routes leave this count by a different mechanism than the other
// forty-seven -- the regex stops matching them at all. Both mechanisms are asserted
// separately below so a future edit cannot hide one behind the other.
const EXPECTED_WILDCARD_ROUTES = 11;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? jsFiles(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []
  );
}

test("temporary wildcard key scopes have exact burn-down count", () => {
  const endpoints = path.resolve(__dirname, "../../../endpoints");
  const count = jsFiles(endpoints).reduce((total, file) => total + (fs.readFileSync(file, "utf8").match(/validApiKey\(API_KEY_SCOPES\.TEMPORARY_ALL\)/g) || []).length, 0);
  expect(API_KEY_SCOPES.TEMPORARY_ALL).toBe("*");
  expect(count).toBe(EXPECTED_WILDCARD_ROUTES);
});

test("no browser extension route carries a wildcard scope any more", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../endpoints/browserExtension.js"),
    "utf8"
  );
  expect(source).not.toContain("API_KEY_SCOPES.TEMPORARY_ALL");
  expect(source.match(/validBrowserExtensionApiKey\(extensionScopeFor\(/g)).toHaveLength(5);
});

test("the extension middleware grants a fixed scope set, never a wildcard", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../utils/middleware/validBrowserExtensionApiKey.js"),
    "utf8"
  );
  expect(source).not.toContain('scopes: ["*"]');
  expect(source).not.toContain('includes("*")');
});
