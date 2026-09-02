/**
 * issue 123: `assignableRoles` on GET /system/my-capabilities.
 *
 * Three places in the admin UI decide which roles a caller may hand out by comparing
 * role STRINGS in the browser (UserRow's ModMap, and the two modals' `role === "admin"`
 * checks). That is the fixed hierarchy `utils/helpers/admin/index.js` says it removed
 * from the server, for a reason its comment states: a hierarchy cannot express a
 * delegated admin who may create members but not other admins.
 *
 * The server answers this through `canAssignLegacyRole`, which compares permission SETS.
 * This adds the answer to the capabilities response so the browser stops guessing.
 *
 * Driven over the real route against a real database with real grants. The whole point
 * is that the answer follows grants rather than the legacy role column, so a fixture
 * built on role strings would assert the thing being removed.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "assignable-roles-")
  );

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `assignable_roles_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

/** Ids are fixed so the mocked session can name one before the rows exist. */
const BASE_ID = 8000 + (process.pid % 900);
const IDS = {
  admin: BASE_ID,
  manager: BASE_ID + 1,
  default: BASE_ID + 2,
  delegated: BASE_ID + 3,
};

/**
 * The session the route sees. Mutated per test rather than re-mounting the app: the
 * subject is what the endpoint computes for a given actor, not how a token is parsed.
 */
let session = { id: IDS.admin, impersonatedBy: null, apiKey: null };

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    // eslint-disable-next-line global-require
    const current = require("../../../__testHelpers__/authorization/assignableRolesSession").current();
    if (current.apiKey) {
      // The resolver reads `apiKeyContext`, not `apiKey`: a key is a bearer credential
      // for its creator, and the context is what carries the creator lookup and scopes.
      response.locals.apiKeyContext = current.apiKey;
    } else if (current.id !== null) {
      response.locals.user = { id: current.id, suspended: 0 };
      if (current.impersonatedBy)
        response.locals.impersonatedBy = current.impersonatedBy;
    }
    next();
  },
}));

let prisma;
let server;
let baseUrl;
let repository;
let keyIdForAdmin;

const capabilities = async () => {
  const response = await fetch(`${baseUrl}/system/my-capabilities`);
  return { status: response.status, body: await response.json() };
};

const as = (patch) => {
  session = { id: null, impersonatedBy: null, apiKey: null, ...patch };
  require("../../../__testHelpers__/authorization/assignableRolesSession").set(session);
};

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("this suite requires DATABASE_URL on PostgreSQL");
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  process.env.DATABASE_URL = testUrl;

  // utils/prisma binds DATABASE_URL at first require and is a singleton across the
  // suites sharing this process. Reset so the client below is this suite's own —
  // otherwise these writes land in the shared database, the tests still pass because
  // they only read back what they wrote, and OTHER suites go red on the leaked rows.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  repository = require("../../../utils/authorization/policyRepository");
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  for (const [label, legacyRole] of [
    ["admin", "admin"],
    ["manager", "manager"],
    ["default", "default"],
    // A delegated admin is NOT a legacy role: it is a `default` user holding the
    // seeded `setup_admin` grant, which is the only org role carrying `user.manage`
    // without carrying `super_admin`. This is the actor the whole feature exists for.
    ["delegated", "default"],
  ]) {
    const user = await prisma.users.create({
      data: {
        id: IDS[label],
        username: `ar-${label}-${dbSuffix}`,
        password: "unused",
        role: legacyRole,
      },
    });
    await syncLegacyRoleGrant(user, { db: prisma });
  }

  const setupAdmin = await prisma.roles.findFirstOrThrow({
    where: { name: "setup_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(IDS.delegated),
    roleId: setupAdmin.id,
    db: prisma,
  });

  // A real key row, created by the full admin. The point of RF-3 is that the type guard
  // excludes a principal that WOULD otherwise be offered roles.
  const key = await prisma.api_keys.create({
    data: {
      secretDigest: crypto.createHash("sha256").update(`ar-key-${dbSuffix}`).digest(),
      keyPrefix: `ar${dbSuffix.slice(0, 4)}`,
      scopes: JSON.stringify(["system.write"]),
      createdBy: IDS.admin,
    },
  });
  keyIdForAdmin = key.id;

  const { systemEndpoints } = require("../../../endpoints/system");
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}, 300_000);

// #142: an explicit timeout, because jest's DEFAULT for a hook is 5 s and this one
// does four things that are not guaranteed to fit in it — draining live HTTP
// connections, closing the server, disconnecting the pool, and `DROP DATABASE ...
// WITH (FORCE)` against a server that may be serving other worktrees' gates at the
// same time. `beforeAll` above already carries `300_000` for the same reason; the
// teardown was simply never given one.
//
// The failure this produces is worth naming, because it does not look like a timeout:
// all 18 tests PASS and the suite still reports `● Test suite failed to run` with
// exit 1. Read quickly that is indistinguishable from an import-time crash, which is
// how it was first reported (as jsonwebtoken failing to load under node 22 — measured
// not to be true: `require("buffer").SlowBuffer` is present under jest's `node`
// environment and `jsonwebtoken` imports clean).
//
// 30 s rather than 300 s: this hook should take under a second, so the number is
// there to absorb a loaded machine, not to hide a hang. A teardown that genuinely
// needs minutes is a defect, and this timeout is short enough to still say so.
afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await admin.$disconnect();
}, 30_000);

describe("RF-1: the answer follows grants, in three tiers", () => {
  it("a full admin may assign every role", async () => {
    as({ id: IDS.admin });

    const { body } = await capabilities();

    expect(body.assignableRoles.sort()).toEqual(
      ["admin", "default", "manager"]
    );
  });

  it("a delegated admin may assign members but not other admins", async () => {
    // The case a role-string hierarchy cannot express, and the reason this field is a
    // list rather than a boolean. `delegated` carries the legacy role "default" — so a
    // check reading users.role would answer for the wrong actor entirely.
    as({ id: IDS.delegated });

    const { body } = await capabilities();

    expect(body.assignableRoles.sort()).toEqual(["default", "manager"]);
    expect(body.assignableRoles).not.toContain("admin");
  });

  it("a legacy manager gets nothing, because it does not hold user.manage", async () => {
    // A DIFFERENT reason from the case above, so it is a different test. The seeded
    // `member` role carries only chat.send and org.member; the admin routes are gated
    // on `user.manage`, which a legacy manager never had. The UI's ModMap says
    // ["manager","default"] here — those options 403 when clicked today.
    as({ id: IDS.manager });

    const { body } = await capabilities();

    expect(body.assignableRoles).toEqual([]);
    expect(body.capabilities["user.manage"]).toBe(false);
  });

  it("a plain user gets nothing", async () => {
    as({ id: IDS.default });

    const { body } = await capabilities();

    expect(body.assignableRoles).toEqual([]);
  });
});

describe("RF-2: the field agrees with the write path", () => {
  it("every role offered is one validRoleSelection would accept, and every role withheld is one it refuses", async () => {
    // Asserted against the helper the ROUTES call, not against a table restated here.
    // A test that hardcoded the expected list would keep passing if the endpoint and
    // the write path drifted apart, which is the only failure that matters.
    const {
      validRoleSelection,
    } = require("../../../utils/helpers/admin");
    as({ id: IDS.delegated });

    const { body } = await capabilities();
    const actor = {
      type: "user",
      id: String(IDS.delegated),
      orgId: 1,
      workspaceIds: [],
    };

    for (const role of ["admin", "manager", "default"]) {
      const writePath = await validRoleSelection(actor, { role });
      expect([role, body.assignableRoles.includes(role)]).toEqual([
        role,
        writePath.valid,
      ]);
    }
  });
});

describe("RF-3: a non-user principal is excluded by a type guard", () => {
  it("an api-key caller gets an empty list", async () => {
    // Created BY the full admin, so the key inherits an actor that would otherwise be
    // offered every role: an empty list here cannot be explained by the creator having
    // no grants.
    as({ apiKey: { keyId: keyIdForAdmin, keyKind: "api-key", scopes: ["system.write"] } });

    const { body } = await capabilities();

    expect(body.capabilities["user.manage"]).toBe(true);
    expect(body.assignableRoles).toEqual([]);
  });

  it("the type guard is what excludes it, not an empty permission lookup", async () => {
    // A spy on canAssignLegacyRole proves nothing here: the `user.manage` gate returns
    // first for this actor, so the helper is uncalled either way and the assertion
    // would pass with the type guard deleted. (Verified: removing the guard leaves the
    // whole suite green.)
    //
    // So the guard is exercised where it is the ONLY thing that can answer — an actor
    // that is not a user but WOULD pass the manage gate. `assignableRolesFor` is called
    // directly for that, because no ingress produces this combination today; the guard
    // exists so that a future one cannot silently start offering roles.
    const {
      assignableRolesFor,
    } = require("../../../utils/helpers/assignableRoles");

    const serviceActor = { type: "service", id: "api-key:1", orgId: 1 };
    expect(
      await assignableRolesFor({ actor: serviceActor, canManageUsers: true, db: prisma })
    ).toEqual([]);

    // And the same shape with type "user" is NOT excluded, so the assertion above is
    // about the type rather than about everything being refused.
    expect(
      await assignableRolesFor({
        actor: { type: "user", id: String(IDS.admin), orgId: 1, workspaceIds: [] },
        canManageUsers: true,
        db: prisma,
      })
    ).not.toEqual([]);
  });
});

describe("RF-4: an exempt service principal is not narrowed", () => {
  // Through `assignableRolesFor`, NOT through `canAssignLegacyRole` directly. The first
  // version of this test called the repository helper and passed while the endpoint
  // returned [] for the same actor — it proved the rule, not the code that uses it.
  // (TL-1 found that; the type guard was cutting SINGLE_USER_ACTOR out.)
  const exempt = () => {
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    return SERVICE_PRINCIPALS;
  };

  it("single-user may assign every role", async () => {
    // A single-user install IS this actor. Narrowing here leaves its only operator
    // with an empty dropdown while the same response says user.manage is true.
    const {
      assignableRolesFor,
    } = require("../../../utils/helpers/assignableRoles");

    const roles = await assignableRolesFor({
      actor: exempt().singleUser,
      canManageUsers: true,
      db: prisma,
    });

    expect(roles.sort()).toEqual(["admin", "default", "manager"]);
  });

  it("core-jobs may too", async () => {
    const {
      assignableRolesFor,
    } = require("../../../utils/helpers/assignableRoles");

    const roles = await assignableRolesFor({
      actor: exempt().coreJobs,
      canManageUsers: true,
      db: prisma,
    });

    expect(roles.sort()).toEqual(["admin", "default", "manager"]);
  });

  it("but a scoped api-key service actor still gets nothing", async () => {
    // In the SAME test file as the two above, because the risk of that fix is
    // over-correction: exempting every `type: "service"` actor would let a scoped key
    // — also a service actor — be offered admin, which is the S-9 hole the policy
    // repository's own comment describes.
    //
    // The key is given its OWN super_admin grant row for the duration of this test.
    // Without one, `heldPermissionIds` resolves nothing for it — every target role
    // comes back false from the permission comparison itself, and the test passes
    // whether or not the exemption is widened. Verified: with a fabricated actor
    // holding no grant, exempting every `type: "service"` left the suite green.
    //
    // With the grant, the set comparison would answer "all three", so `[]` can only
    // be the exempt-set check doing its job.
    const {
      assignableRolesFor,
    } = require("../../../utils/helpers/assignableRoles");
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await prisma.principal_role_grants.create({
      data: {
        orgId: 1,
        principal_type: "service",
        principal_id: "api-key:99",
        role_id: superAdmin.id,
        workspace_id: null,
      },
    });

    try {
      const roles = await assignableRolesFor({
        actor: { type: "service", id: "api-key:99", orgId: 1, workspaceIds: [] },
        canManageUsers: true,
        db: prisma,
      });

      expect(roles).toEqual([]);
    } finally {
      await prisma.principal_role_grants.deleteMany({
        where: { principal_id: "api-key:99" },
      });
    }
  });
});

describe("RF-5: an impersonated session offers nothing", () => {
  it("returns an empty list even though the impersonated user is an admin", async () => {
    // No dedicated impersonation branch exists, and none is wanted (TL-1 N-1). The
    // `user.manage` gate does this on its own: that action is not in READ_ACTIONS, so
    // the engine returns `impersonated_mutation_denied` (engine.js:74-76) before any
    // policy lookup. The mutation that must turn this red is adding `user.manage` to
    // READ_ACTIONS — not removing a guard, because there is no guard to remove.
    as({ id: IDS.admin, impersonatedBy: IDS.delegated });

    const { body } = await capabilities();

    expect(body.assignableRoles).toEqual([]);
  });

  it("and the mutation really is denied, so the empty list is not over-cautious", async () => {
    // The premise, asserted rather than assumed: if impersonated mutations were in
    // fact allowed, the empty list above would be hiding a capability the session has.
    const {
      DatabaseAuthorizationEngine,
    } = require("../../../utils/authorization/engine");
    const engine = new DatabaseAuthorizationEngine();
    const org = { type: "org", id: "1", orgId: 1, workspaceId: null };

    const decision = await engine.authorizeMany({
      actor: {
        type: "user",
        id: String(IDS.admin),
        orgId: 1,
        workspaceIds: [],
        impersonatedBy: { type: "user", id: String(IDS.delegated) },
      },
      action: "user.manage",
      resources: [org],
    });

    expect(decision.get(0)?.allowed).toBe(false);
  });
});

describe("RF-6: the two answers in one response cannot disagree", () => {
  it.each([
    ["admin", () => IDS.admin],
    ["delegated admin", () => IDS.delegated],
    ["legacy manager", () => IDS.manager],
    ["plain user", () => IDS.default],
  ])(
    "for a %s, an empty list and a false user.manage go together",
    async (_label, id) => {
      // The gate reads the `user.manage` boolean out of the batch the route already
      // computes, rather than asking the engine a second time. Two decisions in one
      // body that disagree would be worse than either answer alone, so the invariant
      // is asserted on the SAME response.
      as({ id: id() });

      const { body } = await capabilities();

      expect([
        body.capabilities["user.manage"],
        body.assignableRoles.length === 0,
      ]).toEqual([body.capabilities["user.manage"], !body.capabilities["user.manage"]]);
    }
  );
});

describe("the existing halves of the response are untouched", () => {
  it("capabilities still carries every org action, and the workspace half still absent without the query", async () => {
    as({ id: IDS.admin });

    const { status, body } = await capabilities();

    expect(status).toBe(200);
    // `toHaveProperty("chat.read_others")` reads the dot as a PATH — it would look for
    // a nested `read_others` under `chat` and fail on a correct response. The action
    // names contain dots, so membership is asserted on the key list instead.
    expect(Object.keys(body.capabilities).sort()).toEqual(
      [
        "access.diagnose",
        "chat.read_others",
        "document.bulk_export",
        "key.manage",
        "settings.write",
        "user.manage",
        "workspace.create",
      ].sort()
    );
    expect(body).not.toHaveProperty("workspace");
  });

  it("an anonymous caller gets neither capabilities nor the new field", async () => {
    // The route's existing early return. The new field must not turn that into a
    // partially-populated body.
    as({ id: null });

    const { body } = await capabilities();

    expect(body).toEqual({ capabilities: {} });
  });
});
