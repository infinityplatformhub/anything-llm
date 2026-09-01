const fs = require("fs");
const path = require("path");

const { API_KEY_SCOPES } = require("../../../utils/apiKeySecurity/scopes");

const EXPECTED_WILDCARD_ROUTES = 22;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? jsFiles(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []
  );
}

test("temporary wildcard key scopes have exact burn-down count", () => {
  const endpoints = path.resolve(__dirname, "../../../endpoints");
  const count = jsFiles(endpoints).reduce((total, file) => total + (fs.readFileSync(file, "utf8").match(/valid(?:BrowserExtension)?ApiKey\(API_KEY_SCOPES\.TEMPORARY_ALL\)/g) || []).length, 0);
  expect(API_KEY_SCOPES.TEMPORARY_ALL).toBe("*");
  expect(count).toBe(EXPECTED_WILDCARD_ROUTES);
});
