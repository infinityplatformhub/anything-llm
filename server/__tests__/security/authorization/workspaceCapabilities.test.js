process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "workspace-caps-")
  );

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parse } = require("hermes-eslint");
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
const REPO_DIR = path.join(__dirname, "../../../..");
const MOCKUP_FILE = path.join(
  REPO_DIR,
  "docs/superpowers/mockups/frontend-authz-capabilities.html"
);
const TASK_ENV_FILE = path.join(REPO_DIR, ".infi/task-40.env");

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

// Parse actual call expressions so comments, strings, regex literals, and longer
// identifiers cannot masquerade as authorization gates.
function permissionGates(source) {
  const gates = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "requirePermission" &&
      node.arguments[0]?.type === "Literal" &&
      typeof node.arguments[0].value === "string"
    ) {
      const resource = node.arguments[1];
      const resolver =
        resource?.type === "Identifier"
          ? resource.name
          : resource?.type === "CallExpression" &&
              resource.callee?.type === "Identifier"
            ? resource.callee.name
            : null;
      if (resolver) gates.push({ action: node.arguments[0].value, resolver });
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };

  visit(parse(source, { sourceType: "script" }));
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

describe("permissionGates", () => {
  test("returns calls, not comments, strings, templates, or identifier substrings", () => {
    const source = `
      requirePermission("live.action", orgResource);
      // requirePermission("line.comment", orgResource);
      /* requirePermission("block.comment", orgResource); */
      'requirePermission("string.literal", orgResource)';
      notrequirePermission("prefixed.identifier", orgResource);
      /requirePermission\("regex.literal", orgResource\)/;
      \`template before requirePermission("template.literal", orgResource)\`;
      requirePermission("second.live", workspaceBySlug);
    `;

    expect(permissionGates(source)).toEqual([
      { action: "live.action", resolver: "orgResource" },
      { action: "second.live", resolver: "workspaceBySlug" },
    ]);
  });
});

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
    const taskEnv = fs.readFileSync(TASK_ENV_FILE, "utf8");
    const approvedSha = /^MOCKUP_SHA=(\S+)$/m.exec(taskEnv)?.[1];
    if (!approvedSha) throw new Error(`Missing MOCKUP_SHA in ${TASK_ENV_FILE}`);

    const mockup = fs.readFileSync(MOCKUP_FILE);
    const actualSha = crypto
      .createHash("sha1")
      .update(`blob ${mockup.length}\0`)
      .update(mockup)
      .digest("hex");
    if (actualSha !== approvedSha) {
      throw new Error(
        "The mockup changed after approval — re-approval required, or update MOCKUP_SHA if the change was approved"
      );
    }

    const match = /const\s+WS_CAPS\s*=\s*(\[[^;]*\]);/.exec(
      mockup.toString("utf8")
    );
    if (!match) throw new Error(`Could not parse WS_CAPS from ${MOCKUP_FILE}`);
    const approved = JSON.parse(match[1]);

    // Capability order has no meaning to authorizeMany or UI lookups. Sorting
    // both full arrays ignores order while still exposing omissions, additions,
    // and duplicates.
    const actual = [...WORKSPACE_CAPABILITIES].sort();
    const expected = [...approved].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        "WORKSPACE_CAPABILITIES drifted from the approved mockup WS_CAPS"
      );
    }
  });
});
