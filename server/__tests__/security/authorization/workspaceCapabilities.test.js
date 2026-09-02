process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "workspace-caps-")
  );

const fs = require("fs");
const path = require("path");
const {
  ORG_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
} = require("../../../endpoints/system");
const {
  ACTION_SCOPES,
  ALL_ACTIONS,
} = require("../../../prisma/seeds/permissions");

const ENDPOINTS_DIR = path.join(__dirname, "../../../endpoints");

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const endpointSources = javascriptFiles(ENDPOINTS_DIR)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("capability vocabulary by resource scope", () => {
  test("workspace capabilities contain no org-scoped actions", () => {
    expect(
      WORKSPACE_CAPABILITIES.filter((action) => ACTION_SCOPES[action] === "org")
    ).toEqual([]);
  });

  test("org capabilities contain no workspace-scoped actions", () => {
    expect(
      ORG_CAPABILITIES.filter(
        (action) => ACTION_SCOPES[action] === "workspace"
      )
    ).toEqual([]);
  });

  test("both capability lists are non-empty", () => {
    expect(ORG_CAPABILITIES.length).toBeGreaterThan(0);
    expect(WORKSPACE_CAPABILITIES.length).toBeGreaterThan(0);
  });

  test("every capability is part of the seeded vocabulary", () => {
    for (const action of [...ORG_CAPABILITIES, ...WORKSPACE_CAPABILITIES]) {
      expect(ALL_ACTIONS).toContain(action);
    }
  });

  test("every org capability backs a server gate at org scope", () => {
    for (const action of ORG_CAPABILITIES) {
      const gate = new RegExp(
        `requirePermission\\(\\s*["']${escapeRegExp(action)}["']\\s*,\\s*orgResource`
      );
      expect(gate.test(endpointSources)).toBe(true);
    }
  });
});
