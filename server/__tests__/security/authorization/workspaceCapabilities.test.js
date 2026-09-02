process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "workspace-caps-")
  );

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildRouter } = require("./routeGateSweepHelper");
const {
  ORG_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
} = require("../../../endpoints/system");
const {
  ACTION_SCOPES,
  ALL_ACTIONS,
} = require("../../../prisma/seeds/permissions");

const REPO_DIR = path.join(__dirname, "../../../..");
const MOCKUP_FILE = path.join(
  REPO_DIR,
  "docs/superpowers/mockups/frontend-authz-capabilities.html"
);
const TASK_ENV_FILE = path.join(REPO_DIR, ".infi/task-40.env");

const { app } = buildRouter();
const mountedRoutes = app._router.stack.filter((layer) => layer.route);
const mountedGates = mountedRoutes.flatMap((layer) =>
  layer.route.stack
    .map((handler) => handler.handle)
    .filter((handler) => handler?.action && handler.resolveResource)
);

async function scopeOf(resolveResource) {
  try {
    const resource = await resolveResource({}, {});
    return resource && resource.workspaceId == null ? "org" : "workspace";
  } catch {
    // Workspace resolvers need route input and may consult stored rows. With an
    // empty request they return null or throw; unlike orgResource, they cannot
    // positively resolve the org and therefore cannot satisfy an org gate.
    return "workspace";
  }
}

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

  test("every org capability backs a mounted server gate at org scope", async () => {
    expect(mountedRoutes.length).toBeGreaterThan(100);
    const capabilityGates = mountedGates.filter((gate) =>
      ORG_CAPABILITIES.includes(gate.action)
    );
    expect(capabilityGates.length).toBeGreaterThan(0);

    for (const action of ORG_CAPABILITIES) {
      const scopes = await Promise.all(
        capabilityGates
          .filter((gate) => gate.action === action)
          .map((gate) => scopeOf(gate.resolveResource))
      );
      expect(scopes).toContain("org");
    }

    expect(
      capabilityGates.filter((gate) => gate.action === "workspace.create")
    ).toHaveLength(2);
  });

  test("every workspace capability backs a mounted workspace-scoped gate", async () => {
    expect(mountedRoutes.length).toBeGreaterThan(100);
    const capabilityGates = mountedGates.filter((gate) =>
      WORKSPACE_CAPABILITIES.includes(gate.action)
    );
    expect(capabilityGates.length).toBeGreaterThan(0);

    for (const action of WORKSPACE_CAPABILITIES) {
      const scopes = await Promise.all(
        capabilityGates
          .filter((gate) => gate.action === action)
          .map((gate) => scopeOf(gate.resolveResource))
      );
      expect(scopes).toContain("workspace");
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
