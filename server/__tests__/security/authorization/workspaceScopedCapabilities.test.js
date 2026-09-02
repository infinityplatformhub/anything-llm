/**
 * #40 task 2: GET /system/my-capabilities?workspaceId=<id>.
 *
 * The org-only answer could not tell a UI whether THIS caller may write in THIS
 * workspace, so the UI kept gating on role strings (T-8). This adds the
 * workspace half without moving the org half.
 *
 * Three properties, each with its own reason to exist:
 *
 *  1. The org half survives a workspace-half failure. `authorizeMany` re-throws
 *     a contract error for the WHOLE batch, so one org-scoped action asked at
 *     workspace scope would otherwise take down every org capability — the
 *     failure the #53 comment at system.js:93 warns about.
 *  2. A workspace the caller cannot see answers `workspace: null`. The lookup
 *     runs through an actor-filtered query, so "absent" and "someone else's"
 *     fall out of the same query and cannot be told apart by construction
 *     rather than by a hand-written branch.
 *  3. Existence does not leak ahead of membership (#41 /v1/document shape).
 *     Compared on the raw body and content-length, because key order leaks too.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t2-caps-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "workspace-caps-api-key-pepper-32-bytes-min";

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
const testDb = `t2_wscaps_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

const ACTOR = { id: 8000 + (process.pid % 900) };
const OTHER = { id: 8000 + (process.pid % 900) + 1 };

// The actor the endpoint sees is whatever validatedRequest left in
// response.locals. Tests flip this to reach the service/embed shapes, which
// carry no user id at all.
let mockLocals = null;
jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    Object.assign(response.locals, mockLocals);
    next();
  },
}));

let prisma;
let server;
let baseUrl;
let repository;
let memberWorkspace;
let apiKeyId;
let foreignWorkspace;

const asUser = (id) => ({ multiUserMode: true, user: { id, suspended: 0 } });

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#40 task 2 tests require DATABASE_URL on PostgreSQL");
  }
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

  // Same singleton hazard as myCapabilities.test.js: utils/prisma binds
  // DATABASE_URL at first require, and a sibling suite in the same runInBand
  // process may already have loaded it against the shared database. Reset so
  // the require below is ours — otherwise every write lands elsewhere and the
  // reads still pass, because they only read back what they wrote.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  await prisma.users.create({
    data: { id: ACTOR.id, username: `ws-caps-${dbSuffix}`, password: "unused" },
  });
  await prisma.users.create({
    data: {
      id: OTHER.id,
      username: `ws-caps-other-${dbSuffix}`,
      password: "unused",
    },
  });

  const memberRole = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(ACTOR.id),
    roleId: memberRole.id,
    db: prisma,
  });

  memberWorkspace = await prisma.workspaces.create({
    data: { name: `member-ws-${dbSuffix}`, slug: `member-ws-${dbSuffix}` },
  });
  foreignWorkspace = await prisma.workspaces.create({
    data: { name: `foreign-ws-${dbSuffix}`, slug: `foreign-ws-${dbSuffix}` },
  });
  await prisma.workspace_users.create({
    data: { user_id: ACTOR.id, workspace_id: memberWorkspace.id },
  });
  // foreignWorkspace deliberately gets a DIFFERENT member: it exists and the
  // actor cannot see it, which is the case an existence oracle would expose.
  await prisma.workspace_users.create({
    data: { user_id: OTHER.id, workspace_id: foreignWorkspace.id },
  });

  // A real api key row, created by the same member: resolveActor reads
  // createdBy to find the grant principal, so a key with no row resolves to a
  // null actor and the test would prove nothing about the service shape.
  const apiKey = await prisma.api_keys.create({
    data: {
      secretDigest: Buffer.from(`ws-caps-digest-${dbSuffix}`),
      keyPrefix: `wc_${dbSuffix}`,
      scopes: JSON.stringify(["*"]),
      createdBy: ACTOR.id,
    },
  });
  apiKeyId = apiKey.id;

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

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`
    );
    await admin.$disconnect();
  }
}, 60_000);

// Returns the RAW body and content-length as well as the parsed shape: two of
// the assertions below are about bytes, not about deep equality.
async function ask(query = "") {
  const response = await fetch(`${baseUrl}/system/my-capabilities${query}`);
  const raw = await response.text();
  return {
    status: response.status,
    raw,
    length: response.headers.get("content-length"),
    body: JSON.parse(raw),
  };
}

beforeEach(() => {
  mockLocals = asUser(ACTOR.id);
});

describe("#40 task 2: workspace-scoped capabilities", () => {
  test("no query answers the org-only shape, unchanged", async () => {
    const { status, body } = await ask();
    expect(status).toBe(200);
    const { ORG_CAPABILITIES } = require("../../../endpoints/system");
    expect(Object.keys(body.capabilities).sort()).toEqual(
      [...ORG_CAPABILITIES].sort()
    );
    // Absent, not null: adding a `workspace` key to the no-query response would
    // change the contract three existing call sites read.
    expect(body).not.toHaveProperty("workspace");
  });

  test("a workspace the caller belongs to answers the workspace vocabulary", async () => {
    const { body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(body.workspace).not.toBeNull();
    expect(body.workspace.id).toBe(memberWorkspace.id);
    const { WORKSPACE_CAPABILITIES } = require("../../../endpoints/system");
    expect(Object.keys(body.workspace.capabilities).sort()).toEqual(
      [...WORKSPACE_CAPABILITIES].sort()
    );
    // Present-and-false, never absent: the UI must tell "denied" from "the
    // server did not answer".
    for (const value of Object.values(body.workspace.capabilities)) {
      expect(typeof value).toBe("boolean");
    }
    // QA-1 NIT: at least one capability must come back TRUE, or every
    // assertion above is satisfied by an all-false map — which is also what a
    // silently broken lookup returns. chat.send is the one an org member holds
    // in a workspace they belong to.
    expect(body.workspace.capabilities["chat.send"]).toBe(true);
  });

  test("the org half is unchanged by asking about a workspace", async () => {
    const withoutQuery = await ask();
    const withQuery = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(withQuery.body.capabilities).toEqual(withoutQuery.body.capabilities);
  });

  test("the org half survives a workspace half that throws", async () => {
    // TL-1 F1: the original version of this test asked the endpoint to make an
    // org action fail at workspace scope. It cannot: `ACTION_SCOPES` declares a
    // scope for `org.member` alone, and that action is deliberately absent from
    // ORG_CAPABILITIES, so all 7 org capabilities carry scope "any" and none
    // can throw. The test passed with the two batches sharing one try — it was
    // self-satisfying. Make the LOOKUP fail instead, which is reachable.
    const Workspaces = require("../../../models/workspace");
    const spy = jest
      .spyOn(Workspaces.Workspace, "getWithUser")
      .mockRejectedValue(new Error("workspace lookup exploded"));
    try {
      const { status, body } = await ask(`?workspaceId=${memberWorkspace.id}`);
      expect(status).toBe(200);
      const { ORG_CAPABILITIES } = require("../../../endpoints/system");
      // Every org capability still answered — this is what one shared try/catch
      // destroys, turning the whole response into `{capabilities: {}}`.
      expect(Object.keys(body.capabilities).sort()).toEqual(
        [...ORG_CAPABILITIES].sort()
      );
      expect(body).toHaveProperty("workspace", null);
    } finally {
      spy.mockRestore();
    }
  });

  test("the decision is taken under the actor's org, not a literal", async () => {
    // QA-1 F3. `workspaces` has no orgId column, so the row cannot carry one
    // and this is the only place the org can come from. An actor in org 2 must
    // not have its workspace question answered under org 1's policy: the engine
    // reads actor.orgId for the grant lookup (engine.js:176), and a hardcoded
    // resource.orgId would silently disagree with it.
    const { workspaceCapabilities } = require("../../../endpoints/system");
    const seen = [];
    const recordingEngine = {
      authorizeMany: async ({ resources }) => {
        seen.push(resources[0].orgId);
        return new Map([[0, { allowed: false, reason: "recorded" }]]);
      },
    };
    await workspaceCapabilities({
      actor: { type: "user", id: String(ACTOR.id), orgId: 2 },
      engine: recordingEngine,
      user: { id: ACTOR.id },
      workspaceId: String(memberWorkspace.id),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual([2]);
  });

  test("an org capability is never answered in the workspace half", async () => {
    // The two vocabularies must not bleed. An org action asked against a
    // workspace resource would answer `true` off an org-wide grant, telling the
    // UI a workspace affordance exists because of a permission that has nothing
    // to do with that workspace.
    const { body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    const {
      ORG_CAPABILITIES,
      WORKSPACE_CAPABILITIES,
    } = require("../../../endpoints/system");
    const answered = Object.keys(body.workspace.capabilities);
    for (const action of ORG_CAPABILITIES) {
      if (WORKSPACE_CAPABILITIES.includes(action)) continue;
      expect(answered).not.toContain(action);
    }
  });

  test("a workspace the caller cannot see answers null, not a false map", async () => {
    const { status, body } = await ask(`?workspaceId=${foreignWorkspace.id}`);
    expect(status).toBe(200);
    // `{}` would be wrong in a way `null` is not: a caller cannot tell an empty
    // map from "asked and hold nothing".
    expect(body.workspace).toBeNull();
  });

  test("an org-wide grant does not make a non-member workspace visible", async () => {
    // The actor holds a role at org scope, which is exactly the grant that
    // would make an unfiltered lookup answer `{id, ...}` with capabilities set
    // true. Membership, not permission, decides visibility.
    const { body } = await ask(`?workspaceId=${foreignWorkspace.id}`);
    expect(body).toHaveProperty("workspace", null);
  });

  test("an absent workspace and a foreign one are byte-identical", async () => {
    const absentId = foreignWorkspace.id + 10_000;
    const absent = await ask(`?workspaceId=${absentId}`);
    const foreign = await ask(`?workspaceId=${foreignWorkspace.id}`);
    // Both must actually CARRY the key: two org-only bodies are byte-identical
    // too, and would pass this test while proving nothing.
    expect(absent.body).toHaveProperty("workspace", null);
    expect(foreign.body).toHaveProperty("workspace", null);
    // The raw-body comparison is what carries this test: key order and
    // whitespace leak just as well as a different value, and toEqual sees
    // neither. content-length is a cheap corroboration, not the assertion —
    // two different bodies can share a length.
    expect(absent.raw).toBe(foreign.raw);
    expect(absent.length).toBe(foreign.length);
  });

  test("a non-numeric workspaceId answers null without a query", async () => {
    for (const value of ["abc", "1; DROP TABLE users", "", "-1", "1.5"]) {
      const { status, body } = await ask(
        `?workspaceId=${encodeURIComponent(value)}`
      );
      expect(status).toBe(200);
      expect(body.workspace).toBeNull();
    }
  });

  test("a workspaceId that is not a scalar string answers null", async () => {
    // QA-1 F5: express turns `?workspaceId[]=1` into ["1"] and
    // `?workspaceId[x]=1` into {x: "1"}. `Number(["1"])` is 1, so an array
    // would otherwise reach the lookup as a perfectly valid id the caller never
    // wrote.
    for (const query of [
      "?workspaceId[]=1",
      "?workspaceId[]=1&workspaceId[]=2",
      "?workspaceId[x]=1",
    ]) {
      const { status, body } = await ask(query);
      expect(status).toBe(200);
      expect(body).toHaveProperty("workspace", null);
    }
  });

  test("an array carrying the caller's OWN workspace id is still refused", async () => {
    // The shape is refused, not the value: this id would resolve if it arrived
    // as a scalar, which is what makes the array form a bypass rather than a
    // typo.
    const { body } = await ask(`?workspaceId[]=${memberWorkspace.id}`);
    expect(body).toHaveProperty("workspace", null);
  });

  test("a service actor cannot see a populated workspace it has no part in", async () => {
    // TL-1 F2, the case that made the guard load-bearing: `getWithUser` fails
    // OPEN for a caller with no user id, because Prisma turns
    // `some: {user_id: undefined}` into `some: {}` = "has any member". Both
    // workspaces here HAVE members, so an unguarded lookup returns one.
    mockLocals = {
      multiUserMode: true,
      apiKeyContext: { keyId: apiKeyId, keyKind: "api-key" },
    };
    for (const id of [memberWorkspace.id, foreignWorkspace.id]) {
      const { status, body } = await ask(`?workspaceId=${id}`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("workspace", null);
    }
  });

  test("an api key answers null for a workspace its CREATOR belongs to", async () => {
    // The guard must not key on grantPrincipal. This key's creator IS a member
    // of memberWorkspace, so a grantPrincipal-shaped check would report the
    // creator's membership to a caller holding only the key.
    mockLocals = {
      multiUserMode: true,
      apiKeyContext: { keyId: apiKeyId, keyKind: "api-key" },
    };
    const { body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(body).toHaveProperty("workspace", null);
  });

  test("a service actor gets workspace null and keeps its org half", async () => {
    // resolveActor answers `service` for an api key; it carries no user.id, so
    // the actor-filtered lookup has nothing to filter on. Fail closed — and do
    // not let the missing id throw into the outer catch, which would take the
    // org half with it.
    mockLocals = {
      multiUserMode: true,
      // keyKind is DECLARED, never inferred (issue 45) — an unrecognized value
      // fails closed before a branch is chosen, which would make this test pass
      // for the wrong reason.
      apiKeyContext: { keyId: apiKeyId, keyKind: "api-key" },
    };
    const { status, body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(status).toBe(200);
    expect(body.workspace).toBeNull();
    expect(body).toHaveProperty("capabilities");
  });

  test("an anonymous caller gets the empty answer, with no workspace key", async () => {
    mockLocals = { multiUserMode: true };
    const { status, body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(status).toBe(200);
    expect(body.capabilities).toEqual({});
    // No actor at all: the handler returns before either half runs, so there is
    // no workspace key to report. Distinct from `null`, which means "asked, and
    // this caller cannot see it" — the anonymous case never got as far as
    // asking.
    expect(body).not.toHaveProperty("workspace");
  });
});

describe("#40 task 2: view-as (impersonation) answers the impersonated reach", () => {
  // F4. An admin viewing as another user must see what THAT user can do, not
  // what the admin can — otherwise view-as shows an admin-shaped UI and the
  // routes then refuse, which is the failure the whole capability endpoint
  // exists to avoid. The R5 blanket in the engine (engine.js:74) denies every
  // non-read action for an impersonated actor before any policy lookup, so the
  // write half of the workspace vocabulary must come back false regardless of
  // what either party holds.
  test("an impersonated caller holds no workspace write capability", async () => {
    mockLocals = {
      ...asUser(ACTOR.id),
      impersonatedBy: OTHER.id,
    };
    const { status, body } = await ask(`?workspaceId=${memberWorkspace.id}`);
    expect(status).toBe(200);
    expect(body.workspace).not.toBeNull();

    const { READ_ACTIONS } = require("../../../utils/authorization/engine");
    const { WORKSPACE_CAPABILITIES } = require("../../../endpoints/system");
    for (const action of WORKSPACE_CAPABILITIES) {
      if (READ_ACTIONS.has(action)) continue;
      expect(body.workspace.capabilities[action]).toBe(false);
    }
  });

  test("view-as does not widen visibility to the impersonator's workspaces", async () => {
    // The impersonated user is not a member of foreignWorkspace; the fact that
    // an admin is driving the session must not change that answer.
    mockLocals = {
      ...asUser(ACTOR.id),
      impersonatedBy: OTHER.id,
    };
    const { body } = await ask(`?workspaceId=${foreignWorkspace.id}`);
    expect(body).toHaveProperty("workspace", null);
  });
});

describe("#40 task 2: the workspace half cannot take the org half down", () => {
  // The HTTP tests above cannot reach this path: nothing in a healthy fixture
  // makes authorizeMany throw. Without this seam the "org half survives"
  // assertion passes whether or not the catch exists — it asserts the property
  // without exercising it.
  const throwingEngine = (message) => ({
    authorizeMany: async () => {
      const {
        AuthorizationContractError,
      } = require("../../../utils/authorization/errors");
      throw new AuthorizationContractError(message);
    },
  });

  test("a contract error from the workspace batch answers null, not a throw", async () => {
    const { workspaceCapabilities } = require("../../../endpoints/system");
    await expect(
      workspaceCapabilities({
        actor: { type: "user", id: String(ACTOR.id), orgId: 1 },
        engine: throwingEngine("action org.member is not workspace-scoped"),
        user: { id: ACTOR.id },
        // A string, as express always delivers it: after the F5 shape guard a
        // number returns null before reaching what this test asserts.
        workspaceId: String(memberWorkspace.id),
      })
    ).resolves.toBeNull();
  });

  test("a lookup that throws answers null too", async () => {
    const { workspaceCapabilities } = require("../../../endpoints/system");
    await expect(
      workspaceCapabilities({
        actor: { type: "user", id: String(ACTOR.id), orgId: 1 },
        engine: throwingEngine("boom"),
        // A user object whose id getter throws stands in for any lookup failure
        // between here and the database.
        user: {
          get id() {
            throw new Error("lookup exploded");
          },
        },
        // A string, as express always delivers it: after the F5 shape guard a
        // number returns null before reaching what this test asserts.
        workspaceId: String(memberWorkspace.id),
      })
    ).resolves.toBeNull();
  });
});

describe("#40 task 2: the actor-shape guard stops before the database", () => {
  // The HTTP test above ("a service actor gets workspace null") passes even with
  // the guard deleted, because Prisma will not match `user_id: undefined`
  // either. That makes the guard look redundant when it is not: Prisma's
  // treatment of `undefined` inside `some` is not a documented contract, and if
  // it ever changes, an api-key actor would see workspaces it does not belong
  // to. Assert the guard directly — no lookup may be attempted at all.
  test("an actor with no user id never reaches the workspace lookup", async () => {
    const { workspaceCapabilities } = require("../../../endpoints/system");
    const Workspaces = require("../../../models/workspace");
    const spy = jest.spyOn(Workspaces.Workspace, "getWithUser");

    try {
      const {
        SINGLE_USER_ACTOR,
      } = require("../../../utils/authorization/principals");
      const nonUserActors = [
        { type: "service", id: "api-key:1", orgId: 1 },
        SINGLE_USER_ACTOR,
        { type: "embed", id: "embed-uuid", orgId: 1 },
        // A service actor carrying a real user id: the guard keys on TYPE, so
        // a shape that looks like a user must still be refused.
        { type: "service", id: "api-key:2", orgId: 1, grantPrincipal: "user:1" },
      ];
      for (const actor of nonUserActors) {
        await expect(
          workspaceCapabilities({
            actor,
            engine: {
              authorizeMany: async () => {
                throw new Error("the engine must not be reached either");
              },
            },
            user: { id: ACTOR.id },
            // A string, as express always delivers it: after the F5 shape guard a
        // number returns null before reaching what this test asserts.
        workspaceId: String(memberWorkspace.id),
          })
        ).resolves.toBeNull();
      }

      // The engine below throws if touched, so these also pin that NEITHER the
      // lookup nor authorizeMany runs — refusing early is the mechanism, not a
      // second opinion after the query.
      for (const user of [undefined, null, {}, { id: null }, { id: undefined }]) {
        await expect(
          workspaceCapabilities({
            actor: { type: "user", id: String(ACTOR.id), orgId: 1 },
            engine: {
              authorizeMany: async () => {
                throw new Error("the engine must not be reached either");
              },
            },
            user,
            // A string, as express always delivers it: after the F5 shape guard a
        // number returns null before reaching what this test asserts.
        workspaceId: String(memberWorkspace.id),
          })
        ).resolves.toBeNull();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
