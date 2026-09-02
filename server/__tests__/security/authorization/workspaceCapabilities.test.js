process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "workspace-caps-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "workspace-caps-api-key-pepper-32-bytes-min";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildRouter } = require("../../../utils/test/routeGateSweepHelper");
const {
  ORG_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
} = require("../../../endpoints/system");
const {
  ACTION_SCOPES,
  ALL_ACTIONS,
} = require("../../../prisma/seeds/permissions");
const {
  isWorkspaceResolver,
  isOrgResolver,
} = require("../../../utils/middleware/resourceResolvers");

const REPO_DIR = path.join(__dirname, "../../../..");
const MOCKUP_FILE = path.join(
  REPO_DIR,
  "docs/superpowers/mockups/frontend-authz-capabilities.html"
);
const PLAN_FILE = path.join(
  REPO_DIR,
  "docs/superpowers/plans/40-frontend-authz.md"
);

const { app, registrations, skipped } = buildRouter();
const mountedRoutes = app._router.stack.filter((layer) => layer.route);
const mountedGates = mountedRoutes.flatMap((layer) =>
  layer.route.stack
    .map((handler) => handler.handle)
    .filter((handler) => handler?.action && handler.resolveResource)
);

function scopeOf(resolveResource) {
  if (isOrgResolver(resolveResource)) return "org";
  if (isWorkspaceResolver(resolveResource)) return "workspace";
  return null;
}

function hasGateAtScope(gates, action, scope) {
  return gates.some(
    (gate) => gate.action === action && scopeOf(gate.resolveResource) === scope
  );
}

describe("capability vocabulary by resource scope", () => {
  test("the capability sweep mounted every HTTP router", () => {
    expect(registrations).toHaveLength(31);
    expect(mountedRoutes.length).toBeGreaterThan(100);
    expect(
      skipped.filter((entry) => !entry.startsWith("agentWebsocket"))
    ).toEqual([]);
  });

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

  test("every org capability backs a mounted server gate at org scope", () => {
    expect(mountedRoutes.length).toBeGreaterThan(100);
    const capabilityGates = mountedGates.filter((gate) =>
      ORG_CAPABILITIES.includes(gate.action)
    );
    expect(capabilityGates.length).toBeGreaterThan(0);

    for (const action of ORG_CAPABILITIES) {
      expect(hasGateAtScope(capabilityGates, action, "org")).toBe(true);
    }
  });

  test("every workspace capability backs a mounted workspace-scoped gate", () => {
    expect(mountedRoutes.length).toBeGreaterThan(100);
    const capabilityGates = mountedGates.filter((gate) =>
      WORKSPACE_CAPABILITIES.includes(gate.action)
    );
    expect(capabilityGates.length).toBeGreaterThan(0);

    // document.create has eight legitimate org ingestion gates, and
    // document.delete has two org deletion gates. Neither scope can satisfy
    // this assertion; every listed action also needs workspace wiring.
    for (const action of WORKSPACE_CAPABILITIES) {
      expect(hasGateAtScope(capabilityGates, action, "workspace")).toBe(true);
    }
  });

  test("unknown resolvers are not workspace.members.manage evidence", () => {
    const unknownResolvers = [
      async () => null,
      () => {
        throw new Error("boom");
      },
      () => ({ workspaceId: 1 }),
      Object.assign(async () => null, { resolverName: "unknownResolver" }),
      async function workspaceByIdParam() {
        return null;
      },
      Object.assign(async () => null, { resolverName: "workspaceByIdParam" }),
    ];

    for (const resolveResource of unknownResolvers) {
      const gate = { action: "workspace.members.manage", resolveResource };
      expect(
        hasGateAtScope([gate], "workspace.members.manage", "workspace")
      ).toBe(false);
    }
  });

  test("capability lists match the approved mockup", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    const approvedSha = /^Approved mockup blob SHA: `([0-9a-f]{40})`$/m.exec(
      plan
    )?.[1];
    if (!approvedSha) {
      throw new Error(
        `Missing or malformed approved mockup blob SHA in ${PLAN_FILE}`
      );
    }

    const mockup = fs.readFileSync(MOCKUP_FILE);
    const actualSha = crypto
      .createHash("sha1")
      .update(`blob ${mockup.length}\0`)
      .update(mockup)
      .digest("hex");
    if (actualSha !== approvedSha) {
      throw new Error(
        "The mockup changed after approval — re-approve, or update the approved SHA if the change was approved"
      );
    }

    const source = mockup.toString("utf8");
    for (const [name, capabilities] of [
      ["ORG_CAPS", ORG_CAPABILITIES],
      ["WS_CAPS", WORKSPACE_CAPABILITIES],
    ]) {
      const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\[[^;]*\\]);`).exec(
        source
      );
      if (!match)
        throw new Error(`Could not parse ${name} from ${MOCKUP_FILE}`);
      const approved = JSON.parse(match[1]);

      // Capability order has no meaning to authorizeMany or UI lookups. Sorting
      // full arrays ignores order while still exposing omissions and duplicates.
      const actual = [...capabilities].sort();
      const expected = [...approved].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${name} code list drifted from the approved mockup`);
      }
    }
  });
});
