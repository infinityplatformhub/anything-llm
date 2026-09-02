/**
 * S4b slice 3 (#138): the sync-now route.
 *
 * POST /identity/directory/:provider/sync enqueues one directory sync and answers 202.
 * These tests cover the three things a route like this gets wrong silently:
 *
 *   R1  it must ENQUEUE, not run — a sync behind a 160s lease cannot live in a request
 *   R2  a second click must be ACCEPTED and produce no second run (QA-2's oracle)
 *   R3  the gate is `directory.sync`, and a caller without it is refused
 *
 * WHAT THESE TESTS DO NOT PROVE, stated because the distinction decides who verifies
 * what. The `directory.sync` action's SEED ROW and its grant to super_admin are Dev1's
 * slice, on a separate branch. This suite creates the action and the grant itself, so
 * every assertion here is about the ROUTE's behaviour given a grant — never about
 * whether a real installation has one. A seed-only install could hold no grant at all
 * and this suite would stay green. QA-3 runs the holder assertion against the merged
 * pair; that is the only place it means anything.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "directory-sync-route-")
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
const testDb = `s4b3_route_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

const BASE_ID = 9200 + (process.pid % 700);
const IDS = { super: BASE_ID, setup: BASE_ID + 1 };

let session = { id: IDS.super };

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    // eslint-disable-next-line global-require
    const current = require("../../../__testHelpers__/authorization/assignableRolesSession").current();
    if (current.id !== null) response.locals.user = { id: current.id, suspended: 0 };
    next();
  },
}));

const as = (id) => {
  session = { id, impersonatedBy: null, apiKey: null };
  require("../../../__testHelpers__/authorization/assignableRolesSession").set(session);
};

let prisma;
let server;
let baseUrl;

// THE PROVIDER THIS SUITE SYNCS, and the most important comment in the file.
//
// NO REGISTERED PROVIDER IS DIRECTORY-SYNC-CAPABLE TODAY. The registry holds oidc,
// saml and ldap; all three answer `directorySync: false`. `LarkIdentityProvider` is
// the only capable driver and it is not registered (and `identity_providers` has no
// appId/appSecret columns to configure it with). So the route's allow path is
// currently unreachable in production: every real provider takes the 404 branch.
//
// That is a fact about the SYSTEM, not about this route, and the honest thing is to
// pin both halves — the 404 for every provider that exists (below), and the 202 for a
// capable one, driven here by registering a stub into the exported registry. The stub
// is what makes the allow path testable at all; without it this suite could asserts
// only refusals and would be green against a route that answers 404 unconditionally.
const PROVIDER = `stub-${dbSuffix}`;

const post = async (provider) => {
  const response = await fetch(`${baseUrl}/identity/directory/${provider}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("#138 route tests require DATABASE_URL on PostgreSQL");
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
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

  jest.resetModules();
  prisma = require("../../../utils/prisma");
  const repository = require("../../../utils/authorization/policyRepository");
  // From the LEAF module, not from actorResolver. Two reasons, and the second is the
  // one that bites: actorResolver sits in a require cycle (hotfix #39), and it pulls in
  // `jsonwebtoken`, whose `buffer-equal-constant-time` dependency reads
  // `SlowBuffer.prototype` at import — undefined inside jest's node environment, so the
  // whole suite dies before its first test. That fault is NOT this suite's and is not
  // fixed here: it is pre-existing on main (assignableRolesHttp and identityRoutesHttp
  // fail the same way on an unmodified tree, under node 22; `.nvmrc` pins v18, where
  // SlowBuffer still exists). Reported separately — this file simply does not need
  // actorResolver.
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/principals");
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");

  for (const [label, legacyRole] of [
    ["super", "admin"],
    ["setup", "default"],
  ]) {
    const user = await prisma.users.create({
      data: {
        id: IDS[label],
        username: `ds-${label}-${dbSuffix}`,
        password: "unused",
        role: legacyRole,
      },
    });
    await syncLegacyRoleGrant(user, { db: prisma });
  }

  // The setup_admin actor: a `default` user holding the seeded setup_admin grant. This
  // is the delegated administrator — the caller who can manage users and keys, and the
  // one a "surely an admin can sync" mistake would let through.
  const setupAdmin = await prisma.roles.findFirstOrThrow({
    where: { name: "setup_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(IDS.setup),
    roleId: setupAdmin.id,
    db: prisma,
  });

  // THE ACTION AND ITS GRANT. On the combined branch the SEED provides both (#137's
  // slice), so this defers to it and only fills the gap when it is absent — which is
  // what the queue branch needed on its own, where the seed did not yet carry the
  // action.
  //
  // `upsert` rather than `create` deliberately, and it is the more honest fixture: the
  // suite now runs against whatever the real seed produced, so if the seed ever stops
  // granting `directory.sync` to super_admin, R1's 202 goes red here instead of being
  // masked by a fixture that re-granted it. What this suite still does NOT prove is
  // that a seed-only install holds the grant — that assertion lives in
  // directorySyncPermission.test.js, which is the right place for it.
  const permission = await prisma.permissions.upsert({
    where: { action: "directory.sync" },
    create: { action: "directory.sync", description: "Trigger a directory sync" },
    update: {},
  });
  const superAdmin = await prisma.roles.findFirstOrThrow({
    where: { name: "super_admin", scope: "org" },
  });
  await prisma.role_permissions.upsert({
    where: {
      role_id_permission_id: {
        role_id: superAdmin.id,
        permission_id: permission.id,
      },
    },
    create: { role_id: superAdmin.id, permission_id: permission.id, effect: "allow" },
    update: {},
  });

  // The capable provider, registered for this suite only. `identityProviders` is the
  // registry every caller resolves through, so adding a driver here is exactly what
  // the S4a follow-up will do for Lark — the route sees no difference.
  const {
    identityProviders,
  } = require("../../../utils/identityProviders");
  identityProviders[PROVIDER] = class StubDirectoryProvider {
    static providerId() {
      return PROVIDER;
    }
    static capabilities() {
      return {
        password: false,
        redirect: true,
        directorySync: true,
        groupSync: true,
        deltaSync: false,
      };
    }
  };

  const {
    directorySyncEndpoints,
  } = require("../../../endpoints/identity/directorySync");
  const app = express();
  app.use(express.json());
  directorySyncEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

describe("#138 R1: the route enqueues, it does not run the sync", () => {
  test("a permitted caller gets 202 and exactly one UNCLAIMED job", async () => {
    as(IDS.super);
    const response = await post(PROVIDER);

    // 202, not 200: the sync has been accepted, not performed. A 200 would be the
    // signature of a route that ran the work inline — which is the failure, since a
    // sync outside the queue is a sync outside the queue's exclusion.
    expect(response.status).toBe(202);
    expect(response.body.jobId).toEqual(expect.any(String));

    const rows = await prisma.jobs.findMany({
      where: { type: `directory.sync:${PROVIDER}` },
    });
    expect(rows).toHaveLength(1);
    // UNCLAIMED: pending, no worker, no lease. If the route had run the sync itself
    // this row would be running or completed — and no checkpoint exists either, which
    // is the other half of "nothing was applied".
    expect(rows[0].state).toBe("pending");
    expect(rows[0].workerId).toBeNull();
    expect(rows[0].leaseUntil).toBeNull();
    expect(await prisma.directory_sync_checkpoints.count()).toBe(0);

    // The job runs as the SERVICE principal, not as the caller. What the operator was
    // allowed to do was ASK; what the run may do is the job actor's question.
    expect(JSON.parse(rows[0].actor)).toMatchObject({
      type: "service",
      id: "core-jobs",
    });
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      version: 1,
      provider: PROVIDER,
    });
  }, 120_000);
});

describe("#138 R2: a second click is ACCEPTED, and adds no second run", () => {
  test("QA-2's oracle: the repeat is 202 with the same job, not a 500", async () => {
    // QA-2 rehearsed this against a plausible wrong implementation: a direct `create`
    // relying on @@unique([type, idempotencyKey]) keeps the row count at 1 — the
    // dedupe holds — but the second click answers 500 and the audit records a failed
    // request for what was a correct no-op. So the row count alone is NOT the oracle;
    // the STATUS is half of it.
    as(IDS.super);
    const first = await post(PROVIDER);
    const second = await post(PROVIDER);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // Same job, so the caller can poll one id rather than discovering they have two.
    expect(second.body.jobId).toBe(first.body.jobId);

    expect(
      await prisma.jobs.count({ where: { type: `directory.sync:${PROVIDER}` } })
    ).toBe(1);
  }, 120_000);

  test("R2b: the key is stable for the run, not derived per request", async () => {
    // The property behind the test above, asserted directly: two requests a
    // millisecond apart dedupe because the KEY matched, and a key carrying a
    // per-request timestamp or a UUID would make every click a new row while the
    // 202-and-same-id assertion above still passed on the first pair by luck of
    // timing. Minute resolution is what makes a human's repeated clicks one request.
    const {
      manualSyncKey,
    } = require("../../../endpoints/identity/directorySync");
    const t1 = new Date("2026-09-02T12:02:17.000Z");
    const t2 = new Date("2026-09-02T12:02:59.999Z");
    const t3 = new Date("2026-09-02T12:03:00.000Z");

    expect(manualSyncKey(PROVIDER, t1)).toBe(manualSyncKey(PROVIDER, t2));
    // And it is not a constant: a key that never changes would refuse a genuine
    // second sync forever.
    expect(manualSyncKey(PROVIDER, t3)).not.toBe(manualSyncKey(PROVIDER, t1));
    // Nor shared between providers.
    expect(manualSyncKey("oidc", t1)).not.toBe(manualSyncKey(PROVIDER, t1));
  });
});

describe("#138 R3: the gate is `directory.sync`", () => {
  test("setup_admin is REFUSED, and the refusal enqueues nothing", async () => {
    // Paired with the allow below, deliberately. A deny test alone is green for a
    // route that refuses EVERYONE — including a wrong-signature bug where the engine
    // answers `missing_actor` for every caller, which is the failure mode that makes
    // a permission suite look strict while gating nothing.
    as(IDS.setup);
    const before = await prisma.jobs.count({
      where: { type: `directory.sync:${PROVIDER}` },
    });

    const denied = await post(PROVIDER);
    expect(denied.status).toBe(403);
    expect(
      await prisma.jobs.count({ where: { type: `directory.sync:${PROVIDER}` } })
    ).toBe(before);

    // THE CONTROL: the same route, the same fixture, a caller who holds the action.
    as(IDS.super);
    const allowed = await post(PROVIDER);
    expect(allowed.status).toBe(202);
  }, 120_000);

  test("RF-R: granting ONLY `directory.sync` to the refused caller turns 403 into 202", async () => {
    // TL-1, and the reason the pair above is not enough. setup_admin and super_admin
    // differ by 54 actions, so "setup_admin is refused, super_admin is allowed" is
    // green for a gate asking ANY of those 54 — `user.manage`, `settings.write`,
    // anything super_admin holds and setup_admin does not. It pins that one role has
    // more permissions than the other, which was never in doubt.
    //
    // This varies ONE thing. Same user, same session, same route; the only change
    // between the 403 above and the 202 below is a single `directory.sync` row on the
    // setup_admin role. If the gate asked for any other action, that row would change
    // nothing and this test would stay red.
    //
    // §7.17, third instance (#140 M4, #137, #138): a deny/allow pair between two
    // SEEDED roles pins nothing about the action string. The discriminating fixture is
    // the same principal with and without the one grant.
    as(IDS.setup);
    expect((await post(PROVIDER)).status).toBe(403);

    const setupAdminRole = await prisma.roles.findFirstOrThrow({
      where: { name: "setup_admin", scope: "org" },
    });
    const permission = await prisma.permissions.findUniqueOrThrow({
      where: { action: "directory.sync" },
    });
    // The premise this test rests on: setup_admin must NOT already hold the action, or
    // the 403 above came from somewhere else and the grant below changes nothing.
    // Asserted rather than assumed, because the seed decides this and the seed is not
    // this suite's to control.
    const preexisting = await prisma.role_permissions.findUnique({
      where: {
        role_id_permission_id: {
          role_id: setupAdminRole.id,
          permission_id: permission.id,
        },
      },
    });
    expect(preexisting).toBeNull();

    await prisma.role_permissions.create({
      data: {
        role_id: setupAdminRole.id,
        permission_id: permission.id,
        effect: "allow",
      },
    });

    // No version bump or cache flush is needed: the engine's only memo lives for the
    // duration of one `authorizeMany` call (engine.js — "a longer-lived cache would
    // let a removed membership keep authorizing"), so the next request reads the row
    // just written. Checked rather than assumed — a stale allow-set would have made
    // this test red for a reason unrelated to the gate.
    const nowAllowed = await post(PROVIDER);
    expect(nowAllowed.status).toBe(202);
    expect(nowAllowed.body.jobId).toEqual(expect.any(String));
  }, 120_000);

  test("an unknown or non-syncing provider is 404, before anything is enqueued", async () => {
    as(IDS.super);
    const unknown = await post("nope");
    expect(unknown.status).toBe(404);
    expect(await prisma.jobs.count({ where: { type: "directory.sync:nope" } })).toBe(0);

    // A provider that EXISTS but cannot sync is also 404, and this is the assertion
    // that separates the capability guard from a mere registry lookup: ldap is a real,
    // registered provider whose `directorySync` is false. Without the capability half,
    // this would enqueue a job that fails at handler time, retries to its maximum, and
    // shows the operator a 202 followed by silence.
    const ldap = await post("ldap");
    expect(ldap.status).toBe(404);
    expect(await prisma.jobs.count({ where: { type: "directory.sync:ldap" } })).toBe(0);

    // GAP, pinned as behaviour rather than left to be discovered (#138): `lark` — the
    // provider this entire slice was built for — is not in the registry, so it is a
    // 404 here too. Registering it and giving `identity_providers` its appId/appSecret
    // is the S4a follow-up; when that lands THIS ASSERTION IS THE ONE THAT FLIPS,
    // which is why it names lark specifically rather than another unknown string.
    const lark = await post("lark");
    expect(lark.status).toBe(404);
  }, 120_000);
});
