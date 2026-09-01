const fs = require("fs");
const path = require("path");

const EXPECTED_WILDCARD_ROUTES = 67;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? jsFiles(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []
  );
}

test("temporary wildcard key scopes have exact burn-down count", () => {
  const endpoints = path.resolve(__dirname, "../../../endpoints");
  const count = jsFiles(endpoints).reduce((total, file) => total + (fs.readFileSync(file, "utf8").match(/valid(?:BrowserExtension)?ApiKey\("\*"\)/g) || []).length, 0);
  expect(count).toBe(EXPECTED_WILDCARD_ROUTES);
});
