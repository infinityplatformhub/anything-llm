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
const RESOLVERS_FILE = path.join(
  __dirname,
  "../../../utils/middleware/resourceResolvers.js"
);
const MOCKUP_FILE = path.join(
  __dirname,
  "../../../../docs/superpowers/mockups/frontend-authz-capabilities.html"
);

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

// Ignore comments and unrelated strings so examples and dead text cannot count
// as live gates. Only the first string argument of a real requirePermission call
// is retained as the action being gated.
function permissionGates(source) {
  const gates = [];
  let index = 0;

  const whitespace = () => {
    while (/\s/.test(source[index] || "")) index += 1;
  };
  const string = () => {
    const quote = source[index++];
    let value = "";
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") index += 1;
      value += source[index++] || "";
    }
    index += 1;
    return value;
  };

  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index);
      if (index < 0) break;
    } else if (source.startsWith("/*", index)) {
      index = source.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 2;
    } else if ("\"'`".includes(source[index])) {
      string();
    } else if (source.startsWith("requirePermission", index)) {
      index += "requirePermission".length;
      whitespace();
      if (source[index++] !== "(") continue;
      whitespace();
      if (!"\"'".includes(source[index])) continue;
      const action = string();
      whitespace();
      if (source[index++] !== ",") continue;
      whitespace();
      const resolver = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))?.[0];
      if (resolver) gates.push({ action, resolver });
    } else {
      index += 1;
    }
  }
  return gates;
}

const endpointFiles = javascriptFiles(ENDPOINTS_DIR);
const gatesByFile = new Map(
  endpointFiles.map((file) => [
    file,
    permissionGates(fs.readFileSync(file, "utf8")),
  ])
);
const allGates = [...gatesByFile.values()].flat();

// Every exported resolver except orgResource and grantScopeFromBody always
// resolves an existing workspace or an object contained by one and returns a
// workspaceId. grantScopeFromBody is excluded because its no-workspace branch
// intentionally resolves the org. Deriving exports keeps this aligned as the
// centralized resolver module grows.
const resolverExports = /module\.exports\s*=\s*{([^}]+)}/s.exec(
  fs.readFileSync(RESOLVERS_FILE, "utf8")
)?.[1];
const workspaceResolvers = new Set(
  (resolverExports?.match(/[A-Za-z_$][\w$]*/g) || []).filter(
    (name) => !["orgResource", "grantScopeFromBody"].includes(name)
  )
);

describe("capability vocabulary by resource scope", () => {
  test("workspace capabilities contain no org-scoped actions", () => {
    expect(
      WORKSPACE_CAPABILITIES.filter((action) => ACTION_SCOPES[action] === "org")
    ).toEqual([]);
  });

  test("org capabilities contain no workspace-scoped actions", () => {
    expect(
      ORG_CAPABILITIES.filter((action) => ACTION_SCOPES[action] === "workspace")
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
    expect(endpointFiles.length).toBeGreaterThan(0);
    for (const action of ORG_CAPABILITIES) {
      expect(
        allGates.some(
          (gate) => gate.action === action && gate.resolver === "orgResource"
        )
      ).toBe(true);
    }

    for (const filename of ["workspaces.js", "admin.js"]) {
      const file = path.join(ENDPOINTS_DIR, filename);
      expect(gatesByFile.get(file)).toContainEqual({
        action: "workspace.create",
        resolver: "orgResource",
      });
    }
  });

  test("every workspace capability backs a workspace-scoped server gate", () => {
    for (const action of WORKSPACE_CAPABILITIES) {
      expect(
        allGates.some(
          (gate) =>
            gate.action === action && workspaceResolvers.has(gate.resolver)
        )
      ).toBe(true);
    }
  });

  test("workspace capabilities match the approved mockup", () => {
    const mockup = fs.readFileSync(MOCKUP_FILE, "utf8");
    const match = /const\s+WS_CAPS\s*=\s*(\[[^;]*\]);/.exec(mockup);
    if (!match) throw new Error(`Could not parse WS_CAPS from ${MOCKUP_FILE}`);
    const approved = JSON.parse(match[1]);

    // Capability order has no meaning to authorizeMany or UI lookups. Sorting
    // both full arrays ignores order while still exposing omissions, additions,
    // and duplicates.
    expect([...WORKSPACE_CAPABILITIES].sort()).toEqual([...approved].sort());
  });
});
