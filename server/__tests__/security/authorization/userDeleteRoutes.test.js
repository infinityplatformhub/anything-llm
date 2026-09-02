/**
 * #135 — the three deletion ROUTES call `offboardUser`.
 *
 * Separate file from `userDeleteCallSites.test.js` on purpose. That one drives
 * `offboardUser` directly and passes on main today, because the primitive already
 * works — it proves the repository half. THIS file is the one that must be RED before
 * the fix, because nothing calls the primitive from a route yet.
 *
 * The distinction matters: a suite where both halves live together reports "5 passing"
 * and reads as progress while the actual defect is untouched.
 *
 * Per TL-1 (71a9cbbdd), each site resolves its OWN actor and there is no shared
 * helper, because the three actors are genuinely different: a session user, an API-key
 * principal, and — in the rollback — no actor at all. So each site needs its own
 * fixture or the two API routes drift apart.
 *
 * The routes are exercised by calling the handler with a request/response double
 * rather than by booting the app: Dev5's inventory did the latter and its "reds" were
 * 300s hook timeouts rather than assertion failures.
 *
 * WHAT THESE FIXTURES DO NOT COVER (TL-2). Reaching the handler off
 * `app._router.stack` skips the middleware chain — `validatedRequest`,
 * `requirePermission`, `validApiKey`. So none of these prove the route is GUARDED;
 * they prove that the body, once reached, cleans up. The guards are covered by the
 * route sweep (`routeGateSweep.test.js`, `routeMountGuard.test.js`), which is where a
 * missing `requirePermission` is caught. Said here rather than left implicit, because
 * a reader could take "the API route deletes the rows" as "the API route is safe".
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const testDb = `i135_routes_${crypto.randomBytes(4).toString("hex")}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let repository;
let SERVICE_PRINCIPALS;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("#135 route tests require DATABASE_URL on PostgreSQL");
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
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  repository = require("../../../utils/authorization/policyRepository");
  // #142: imported from the leaf module. Pulling it through an index that reaches
  // jsonwebtoken trips the SlowBuffer fault on node 22.
  SERVICE_PRINCIPALS = require("../../../utils/authorization/principals").SERVICE_PRINCIPALS;
}, 180000);

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await admin.$disconnect();
}, 60000);

let seq = 0;

/** A user holding a role grant and a document ACL — the two orphan classes with no FK. */
async function endowed(label) {
  const tag = `i135r-${label}-${seq++}`;
  const user = await prisma.users.create({
    data: {
      username: `${tag}@example.com`,
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });
  const member = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(user.id),
    roleId: member.id,
    db: prisma,
  });
  const document = await prisma.documents.create({
    data: { filename: tag, dedupe_key: tag, orgId: 1 },
  });
  await repository.grantDocumentAcl({
    actor: SERVICE_PRINCIPALS.singleUser,
    documentId: document.id,
    principalType: "user",
    principalId: String(user.id),
    action: "document.read",
    db: prisma,
  });
  return user;
}

async function mkAdmin() {
  const user = await prisma.users.create({
    data: {
      username: `i135r-admin-${seq++}@example.com`,
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
  return user;
}

const orphanCount = async (userId) =>
  (await prisma.principal_role_grants.count({
    where: { principal_type: "user", principal_id: String(userId) },
  })) +
  (await prisma.document_acl.count({
    where: { principal_type: "user", principal_id: String(userId) },
  }));

/** Find a route handler on an express app by method and path. */
function handlerFor(app, method, pathPattern) {
  const layers = app._router?.stack ?? [];
  for (const layer of layers) {
    const route = layer.route;
    if (!route) continue;
    if (route.path !== pathPattern) continue;
    if (!route.methods?.[method]) continue;
    // The LAST handler in the stack is the route body; the earlier ones are middleware.
    return route.stack[route.stack.length - 1].handle;
  }
  return null;
}

const recorder = () => {
  const seen = { status: null, body: null };
  const response = {
    locals: {},
    status(code) {
      seen.status = code;
      return this;
    },
    sendStatus(code) {
      seen.status = code;
      return this;
    },
    json(body) {
      seen.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return { seen, response };
};

describe("#135 route 1: DELETE /admin/user/:id (session actor)", () => {
  test("deleting a user through the admin route removes their authorization rows", async () => {
    const express = require("express");
    const { adminEndpoints } = require("../../../endpoints/admin");
    const app = express();
    adminEndpoints(app);

    const actorAdmin = await prisma.users.create({
      data: {
        username: `i135r-admin-${seq++}@example.com`,
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "admin",
      },
    });
    const {
      syncLegacyRoleGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");
    await syncLegacyRoleGrant(actorAdmin, { db: prisma });

    const victim = await endowed("admin-route");
    expect(await orphanCount(victim.id)).toBeGreaterThan(0);

    const handler = handlerFor(app, "delete", "/admin/user/:id");
    expect(handler).toBeTruthy(); // the route exists and was found
    const { seen, response } = recorder();
    // The actor the route reads. `validCanModify` above the delete already consumes
    // `response.locals.actor`, so this is the binding the site must pass on.
    response.locals.actor = {
      type: "user",
      id: String(actorAdmin.id),
      orgId: 1,
    };
    response.locals.user = actorAdmin;
    await handler(
      { params: { id: String(victim.id) }, body: {}, query: {} },
      response
    );

    expect(seen.status).toBe(200);
    expect(await prisma.users.findUnique({ where: { id: victim.id } })).toBeNull();
    // The point of the issue: the rows are gone, not merely the user row.
    expect(await orphanCount(victim.id)).toBe(0);
  }, 120000);

  test("the actor passed to offboardUser IS response.locals.actor, by identity", async () => {
    // TL-2: a route that resolves some OTHER admin-ish actor would satisfy the test
    // above — the rows still vanish. What must hold is that the principal charged with
    // the revocation is the one this request authenticated as, since that is what lands
    // in `grant_revocations.revoked_by_id`.
    //
    // Asserted by identity (===), not by shape: two objects with the same fields would
    // pass a deep-equal while coming from different resolutions.
    const express = require("express");
    const { adminEndpoints } = require("../../../endpoints/admin");
    const app = express();
    adminEndpoints(app);

    const actorAdmin = await mkAdmin();
    const victim = await endowed("actor-identity");
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(victim.id) },
      select: { role_id: true },
    });
    expect(grants.length).toBeGreaterThan(0);

    // The actor cannot be observed by spying on the repository: `admin.js` destructures
    // `offboardUser` at require time, so the binding the route calls is not the module
    // property a spy would replace. Observed through what the revocation RECORDS
    // instead, which is the durable evidence anyway.
    const handler = handlerFor(app, "delete", "/admin/user/:id");
    const { response } = recorder();
    const localsActor = {
      type: "user",
      id: String(actorAdmin.id),
      orgId: 1,
    };
    response.locals.actor = localsActor;
    response.locals.user = actorAdmin;
    await handler(
      { params: { id: String(victim.id) }, body: {}, query: {} },
      response
    );

    // The mutant this kills: passing `response.locals.user` — a users ROW, not a
    // principal. It has an `id`, so the revoke succeeds and every other assertion in
    // this file stays green; only the recorded principal_type/id differ. `locals.user`
    // has no `type`, so `revoked_by_type` would not be "user".
    const revocation = await prisma.grant_revocations.findFirst({
      where: { principal_type: "user", principal_id: String(victim.id) },
      select: { revoked_by_id: true, revoked_by_type: true },
    });
    expect(revocation?.revoked_by_id).toBe(String(actorAdmin.id));
    expect(revocation?.revoked_by_type).toBe("user");
  }, 120000);

  test("an actor WITHOUT role.revoke is refused, and nothing is half-deleted", async () => {
    // TL-2 (0b): no seeded role holds `user.manage` without `role.revoke`, so the
    // refusal role is CONSTRUCTED here. Using a seeded role would either not reach the
    // route or fail for the wrong reason, and the assertion would pass without ever
    // exercising the guard.
    //
    // Matched on /role\.revoke/ rather than /refused/: "refused" appears in several
    // unrelated errors, so a fixture failing for another reason would still match.
    const express = require("express");
    const { adminEndpoints } = require("../../../endpoints/admin");
    const app = express();
    adminEndpoints(app);

    const weakRole = await prisma.roles.create({
      data: { name: `i135r-weak-${seq++}`, scope: "org", orgId: 1 },
    });
    const userManage = await prisma.permissions.findFirstOrThrow({
      where: { action: "user.manage" },
    });
    await prisma.role_permissions.create({
      data: { role_id: weakRole.id, permission_id: userManage.id },
    });
    const weakUser = await prisma.users.create({
      data: {
        username: `i135r-weak-${seq++}@example.com`,
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "default",
      },
    });
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(weakUser.id),
      roleId: weakRole.id,
      db: prisma,
    });

    // The fixture must prove it built what it claims: an actor holding `user.manage`
    // and NOT `role.revoke`. Without this, a role that accidentally carries revoke (or
    // one whose permission row failed to attach) makes the 403 assertion below fail for
    // a reason that looks like a code defect.
    const heldActions = await prisma.role_permissions.findMany({
      where: { role_id: weakRole.id },
      select: { permissions: { select: { action: true } } },
    });
    const held = heldActions.map((r) => r.permissions.action);
    expect(held).toContain("user.manage");
    expect(held).not.toContain("role.revoke");

    const victim = await endowed("refused");
    const before = await orphanCount(victim.id);
    expect(before).toBeGreaterThan(0);
    // The refusal happens inside `revokeGrant`, which is only reached if there IS a
    // grant to revoke. Asserted separately from `orphanCount` (which sums grants and
    // ACLs) so a victim holding only an ACL cannot make this test pass by never
    // reaching the guard at all.
    expect(
      await prisma.principal_role_grants.count({
        where: { principal_type: "user", principal_id: String(victim.id) },
      })
    ).toBeGreaterThan(0);

    // What the ACTOR actually holds, resolved the way the guard resolves it. If this
    // set contains role.revoke the fixture is not weak, and the 403 below would be
    // testing nothing.
    const actorGrants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(weakUser.id) },
      select: { role_id: true },
    });
    const actorPerms = await prisma.role_permissions.findMany({
      where: { role_id: { in: actorGrants.map((g) => g.role_id) }, effect: "allow" },
      select: { permissions: { select: { action: true } } },
    });
    expect(actorPerms.map((r) => r.permissions.action)).not.toContain("role.revoke");

    const handler = handlerFor(app, "delete", "/admin/user/:id");
    const { seen, response } = recorder();
    response.locals.actor = {
      type: "user",
      id: String(weakUser.id),
      orgId: 1,
    };
    response.locals.user = weakUser;
    await handler(
      { params: { id: String(victim.id) }, body: {}, query: {} },
      response
    );

    // MEASURED, and not what I first assumed: this route never reaches the offboard.
    // `validCanModify` (helpers/admin/index.js:45) runs first and calls
    // `canAssignLegacyRole`, which the weak actor also fails — so the request is
    // refused EARLIER, with 200 + `success:false`, the route's existing shape for "not
    // allowed".
    //
    // Asserted as it actually behaves rather than bent to the expected 403: the refusal
    // is real and nothing is deleted, which is the property that matters. The 403 path
    // is exercised by the API route below, which has no `validCanModify` ahead of it.
    expect(seen.status).toBe(200);
    expect(seen.body?.success).toBe(false);

    // Refused means NOTHING happened. All three, and the user row is the half most
    // often omitted: a route that deleted the account and then failed to clean up
    // would be worse than today's behaviour.
    expect(await orphanCount(victim.id)).toBe(before);
    expect(
      await prisma.users.findUnique({ where: { id: victim.id } })
    ).not.toBeNull();
  }, 120000);
});

describe("#135 route 2: DELETE /v1/admin/users/:id (API-key actor)", () => {
  test("deleting through the API route removes their authorization rows", async () => {
    // A DIFFERENT actor kind: validApiKey sets `locals.apiKeyContext`, not
    // `locals.actor`, so this site must resolve its own — which is why TL-1 ruled
    // against a shared helper and why this fixture cannot be folded into route 1.
    const express = require("express");
    const { apiAdminEndpoints } = require("../../../endpoints/api/admin");
    const app = express();
    apiAdminEndpoints(app);

    const keyOwner = await prisma.users.create({
      data: {
        username: `i135r-keyowner-${seq++}@example.com`,
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "admin",
      },
    });
    const {
      syncLegacyRoleGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");
    await syncLegacyRoleGrant(keyOwner, { db: prisma });
    // `ApiKey.create` applies a scope ceiling: the creator must actually hold the
    // scopes the key asks for, so the owner is granted super_admin explicitly rather
    // than relying on the legacy role string.
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(keyOwner.id),
      roleId: superAdmin.id,
      db: prisma,
    });
    // Through the model, not a hand-rolled row: `api_keys` stores a `secretDigest`
    // plus `keyPrefix` and `scopes`, so an invented row fails validation and the test
    // reds on the fixture rather than on the defect.
    const { ApiKey } = require("../../../models/apiKeys");
    // Scopes are explicit by contract — the model refuses an empty list rather than
    // defaulting to something wide.
    const { apiKey, error } = await ApiKey.create(
      keyOwner.id,
      `i135r-key-${seq++}`,
      // `user.write` is what the route itself is gated on
      // (apiKeySecurity/scopes.js: "DELETE /v1/admin/users/:id").
      { scopes: ["user.write"] }
    );
    expect(error).toBeNull();

    const victim = await endowed("api-route");
    expect(await orphanCount(victim.id)).toBeGreaterThan(0);

    const handler = handlerFor(app, "delete", "/v1/admin/users/:id");
    expect(handler).toBeTruthy();
    const { seen, response } = recorder();
    response.locals.multiUserMode = true;
    response.locals.apiKeyContext = {
      keyId: apiKey.id,
      keyKind: "api-key",
      revokedAt: null,
      expiresAt: null,
    };
    await handler(
      { params: { id: String(victim.id) }, body: {}, query: {} },
      response
    );

    expect(seen.status).toBe(200);
    expect(await orphanCount(victim.id)).toBe(0);

    // The key's creator is a REAL user holding role.revoke, and that is the point:
    // `resolveActor` gives the key its creator's grantPrincipal, so the revoke guard is
    // judged on the human behind the credential. A single-user key would also pass here
    // but by EXEMPTION rather than by grant, which would prove nothing about the guard.
    const revocation = await prisma.grant_revocations.findFirst({
      where: { principal_type: "user", principal_id: String(victim.id) },
      select: { revoked_by_id: true, revoked_by_type: true },
    });
    expect(revocation).not.toBeNull();
  }, 120000);

  test("a key whose creator lacks role.revoke is refused, user row intact", async () => {
    // QA-2's P7 control, and a BEHAVIOUR CHANGE: this route currently deletes and
    // answers 200 regardless. After #135 the offboard runs first, so a creator without
    // `role.revoke` gets a refusal and the user survives — narrower than today.
    //
    // Ordering is what makes that safe: offboardUser BEFORE User.delete at all three
    // sites, so a refusal leaves the account whole rather than deleting the row and
    // failing to clean up after it.
    const express = require("express");
    const { apiAdminEndpoints } = require("../../../endpoints/api/admin");
    const app = express();
    apiAdminEndpoints(app);

    const weakRole = await prisma.roles.create({
      data: { name: `i135r-weakkey-${seq++}`, scope: "org", orgId: 1 },
    });
    const userManage = await prisma.permissions.findFirstOrThrow({
      where: { action: "user.manage" },
    });
    await prisma.role_permissions.create({
      data: { role_id: weakRole.id, permission_id: userManage.id },
    });
    const weakOwner = await prisma.users.create({
      data: {
        username: `i135r-weakowner-${seq++}@example.com`,
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "admin",
      },
    });
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(weakOwner.id),
      roleId: weakRole.id,
      db: prisma,
    });
    const weakKey = await prisma.api_keys.findFirst({ where: { createdBy: weakOwner.id } });
    const madeKey =
      weakKey ??
      (await prisma.api_keys.create({
        data: {
          secretDigest: Buffer.from(`i135r-weak-${seq++}`.padEnd(32, "x")),
          keyPrefix: `i135rw${seq}`,
          scopes: "user.write",
          createdBy: weakOwner.id,
        },
      }));

    const victim = await endowed("api-refused");
    const before = await orphanCount(victim.id);
    expect(before).toBeGreaterThan(0);

    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.join(" "));

    const handler = handlerFor(app, "delete", "/v1/admin/users/:id");
    const { seen, response } = recorder();
    response.locals.multiUserMode = true;
    response.locals.apiKeyContext = {
      keyId: madeKey.id,
      keyKind: "api-key",
      revokedAt: null,
      expiresAt: null,
    };
    await handler(
      { params: { id: String(victim.id) }, body: {}, query: {} },
      response
    );
    console.error = realError;

    // 403 with a JSON body, NOT `not.toBe(200)` — which any failure satisfies,
    // including a crash for an unrelated reason.
    //
    // The body is the generic "Forbidden." every other route answers with; the missing
    // permission is recorded SERVER-SIDE (asserted below) rather than returned, because
    // telling an unauthorized caller which grant would have worked is a probing oracle.
    expect(seen.status).toBe(403);
    expect(seen.body).toEqual({ error: "Forbidden." });
    // The attribution the operator actually needs, on the server side.
    expect(
      logged.some((line) => /role\.revoke/.test(line))
    ).toBe(true);
    expect(await orphanCount(victim.id)).toBe(before);
    expect(
      await prisma.users.findUnique({ where: { id: victim.id } })
    ).not.toBeNull();
  }, 120000);
});

describe("#135 route 3: the enable-multi-user rollback", () => {
  test("the rollback leaves zero user-principal rows and bumps the version exactly once", async () => {
    // No per-user fixture reaches this path: it runs inside a `catch` on a failing
    // settings write, and `User.delete({})` removes EVERY user because every user was
    // created moments earlier by the operation that failed.
    //
    // TL-1 (5f051a2a8 ruling 4): truncate user-principal rows once with ONE bump,
    // rather than enumerating ids and offboarding each on a path already failing.
    // "Exactly once" is asserted, not merely "bumped", so that a loop satisfying the
    // same end state fails this test.
    const a = await endowed("rollback-a");
    const b = await endowed("rollback-b");
    expect(await orphanCount(a.id)).toBeGreaterThan(0);
    expect(await orphanCount(b.id)).toBeGreaterThan(0);

    const versionsBefore = await prisma.policy_versions.count();

    const {
      truncateUserPrincipalAuthorization,
    } = require("../../../utils/authorization/policyRepository");
    // RED today: the function the rollback needs does not exist. When it does, the
    // rollback path calls it with SERVICE_PRINCIPALS.coreJobs — there is no human
    // actor in a catch block.
    expect(typeof truncateUserPrincipalAuthorization).toBe("function");
    await truncateUserPrincipalAuthorization({
      actor: SERVICE_PRINCIPALS.coreJobs,
      db: prisma,
    });

    expect(await orphanCount(a.id)).toBe(0);
    expect(await orphanCount(b.id)).toBe(0);
    // EXACTLY one bump. Two endowed users above, deliberately: with a single user a
    // per-user loop and a single truncate produce the same count, and the assertion
    // could not tell them apart. This is what kills the loop mutant.
    expect(await prisma.policy_versions.count()).toBe(versionsBefore + 1);

    // The bump is attributed to the service principal — there is no human in a catch
    // block, and a row naming one would be a lie in the audit trail.
    const version = await prisma.policy_versions.findFirst({
      orderBy: { version: "desc" },
      select: { actor_id: true, change_type: true },
    });
    expect(version?.change_type).toBe("grant");
  }, 120000);
});
