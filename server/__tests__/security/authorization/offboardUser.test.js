/**
 * S12 slice 1 (#136): offboarding is a terminal state.
 *
 * Three defects, each measured on `941aa79e8` before this file existed, and each
 * asserted here through the thing that actually enforces it rather than through
 * the column that records it:
 *
 *   a suspended user's API key still authenticates  -> driven through validApiKey
 *   suspending does not bump the policy version     -> read before and after
 *   isConfirmedSingleUser's strictness is load-bearing and untested
 *
 * The third is a PINNING test, not a defect. `validBrowserExtensionApiKey.js:27`
 * checks `suspended` only inside `multiUserMode && …`, which looks like a hole
 * and is not one — measured: `isConfirmedSingleUser` requires ZERO user rows, so
 * any existing user forces `multiUserMode` true and the check runs, and with no
 * users there is nobody to suspend. That guard therefore holds only because the
 * helper is stricter than its name suggests. Relax it to "exactly one user" —
 * which is what the name implies — and the hole opens with nothing to catch it.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s12-offboard-")
  );
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "s12-offboard-api-key-pepper-32-bytes";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const testDb = `s12_offboard_${crypto.randomBytes(4).toString("hex")}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S12 integration tests require DATABASE_URL on PostgreSQL");
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
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}"`);
  await admin.$disconnect();
}, 60000);

const bcrypt = require("bcryptjs");
let seq = 0;
async function mkAdmin() {
  const username = `s12-admin-${seq++}`;
  const user = await prisma.users.create({
    data: {
      username,
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

/** A response double that records what the middleware did to it. */
const recorder = () => {
  const seen = { status: null, body: null, nexted: false };
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
  return { seen, response, next: () => (seen.nexted = true) };
};

/** Drive the real validApiKey middleware and report what it did. */
const authenticate = async (secret) => {
  const middleware = require("../../../utils/middleware/validApiKey");
  const gate = (middleware.validApiKey ?? middleware)("workspace.read");
  const { seen, response, next } = recorder();
  await gate(
    {
      header: (name) =>
        name === "Authorization" ? `Bearer ${secret}` : undefined,
      params: {},
      body: {},
      query: {},
    },
    response,
    next
  );
  return seen;
};

const keyFor = async (user, name = "qa2-key") => {
  const { ApiKey } = require("../../../models/apiKeys");
  const { apiKey, error } = await ApiKey.create(user.id, name, {
    scopes: ["workspace.read"],
  });
  return { apiKey, error };
};


describe("S12 (a): a suspended user's API key must stop authenticating", () => {
  it("refuses the key at the middleware, not merely in the column", async () => {
    // The assertion is on `validApiKey`'s answer. Asserting `revokedAt !== null`
    // would pass on a fix that writes the column and never consults it, which is
    // the same shape as a redaction that reports a hit and leaks the value.
    const user = await mkAdmin();
    const { ApiKey } = require("../../../models/apiKeys");
    const { apiKey, error } = await ApiKey.create(user.id, "s12-key", {
      scopes: ["workspace.read"],
    });
    expect(error).toBeFalsy();
    const secret = apiKey.secret;

    // Through `User.update`, NOT a raw prisma write. The first version of this
    // test set the column directly and so tested nothing: the code under test
    // is the offboarding path, and a raw write skips it entirely while looking
    // like a suspended user.
    const { User } = require("../../../models/user");
    const { success } = await User.update(user.id, { suspended: 1 });
    expect(success).toBe(true);

    const middleware = require("../../../utils/middleware/validApiKey");
    const gate = (middleware.validApiKey ?? middleware)("workspace.read");
    const { seen, response, next } = recorder();
    await gate(
      {
        header: (name) =>
          name === "Authorization" ? `Bearer ${secret}` : undefined,
        params: {},
        body: {},
        query: {},
      },
      response,
      next
    );

    // Diagnostic on failure: say WHICH half is wrong rather than only that the
    // request went through.
    const stored = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    expect(stored.revokedAt).not.toBeNull();
    expect(seen.nexted).toBe(false);
    expect([401, 403]).toContain(seen.status);
  });

  it("ATOMICITY: if revocation fails, the suspension does not land either", async () => {
    // The assertion that a revoke placed AFTER the transaction cannot pass.
    // Measured: moving it outside leaves all six other tests green, because they
    // only observe the END state of a successful call — and both orderings reach
    // the same end state when nothing fails.
    //
    // What separates them is a FAILURE between the two writes. Inside the
    // transaction, a throw rolls the suspension back and the operator sees an
    // error. Outside it, the user is suspended in the UI while their key still
    // works — the worst of the two states, and the one nobody would think to
    // check.
    const user = await mkAdmin();
    const { ApiKey } = require("../../../models/apiKeys");
    await ApiKey.create(user.id, "s12-atomic", { scopes: ["workspace.read"] });

    // The failure is induced with a Prisma middleware, NOT by spying on
    // `prisma.api_keys.updateMany`. Measured: that spy does not fire, because
    // the write happens on the TRANSACTION client, which is a different object —
    // so the mock silently did nothing and the test reported the code broken
    // when it was the fixture. `$use` runs for every client derived from this
    // one, transaction included.
    const { User } = require("../../../models/user");
    const failRevocation = async (params, next) => {
      if (
        !failRevocation.disabled &&
        params.model === "api_keys" &&
        params.action === "updateMany"
      )
        throw new Error("revocation failed");
      return next(params);
    };
    prisma.$use(failRevocation);
    let success;
    try {
      ({ success } = await User.update(user.id, { suspended: 1 }));
    } finally {
      // `$use` has no removal API; neutralise the hook rather than leaving it
      // armed for every later test in this file.
      failRevocation.disabled = true;
    }
    expect(success).toBe(false);

    // The suspension must have rolled back with it.
    const row = await prisma.users.findUnique({ where: { id: user.id } });
    expect(row.suspended).toBe(0);
  });

  it("CONTROL: an active user's key still authenticates", async () => {
    // Without this, refusing every key would pass the test above.
    const user = await mkAdmin();
    const { ApiKey } = require("../../../models/apiKeys");
    const { apiKey } = await ApiKey.create(user.id, "s12-live-key", {
      scopes: ["workspace.read"],
    });

    const middleware = require("../../../utils/middleware/validApiKey");
    const gate = (middleware.validApiKey ?? middleware)("workspace.read");
    const { seen, response, next } = recorder();
    await gate(
      {
        header: (name) =>
          name === "Authorization" ? `Bearer ${apiKey.secret}` : undefined,
        params: {},
        body: {},
        query: {},
      },
      response,
      next
    );

    expect(seen.nexted).toBe(true);
    expect(seen.status).toBeNull();
  });
});

// S12 (b): suspending must bump the policy version.
//
// NOT IN THIS SLICE, deliberately, and named here so the gap is visible rather
// than forgotten. TL-2 ruled the bump belongs to an `offboardUser` inside
// `policyRepository.js` — an outside caller passing a bare `SCOPE_KEY(1)` bumps
// successfully while `cache.invalidateScopes` drops only exact-scope entries, so
// the workspace cache stays stale after a suspension. That file is #134's lane
// (Dev3) until it merges.
//
// The two tests for it were written and CONFIRMED RED against `941aa79e8`
// (version 13 before, 13 after) before being held back. They land with the
// `offboardUser` slice, together with the fixture TL-2 requires: the assertion
// is that the user's workspace-scoped cache entries are actually invalidated,
// observed through `cache.invalidateScopes` behaviour — never through
// "bumpVersion was called".

describe("S12 (c): PINNING — isConfirmedSingleUser requires ZERO users", () => {
  // Not a defect. This pins the coupling that makes
  // `validBrowserExtensionApiKey.js:27`'s `multiUserMode &&` guard safe, so that
  // relaxing the helper cannot silently open the extension-key hole.
  it("returns false as soon as ANY user row exists", async () => {
    const {
      isConfirmedSingleUser,
    } = require("../../../utils/authorization/actorResolver");
    const { SystemSettings } = require("../../../models/systemSettings");

    await prisma.system_settings.upsert({
      where: { label: "multi_user_mode" },
      update: { value: "false" },
      create: { label: "multi_user_mode", value: "false" },
    });
    expect(await SystemSettings.isMultiUserMode()).toBe(false);

    // Emptying the table is what this assertion needs — `isConfirmedSingleUser`
    // is defined as "zero user rows", so there is no narrower delete that
    // reaches the state under test. Every user created by this file is restored
    // or irrelevant by the time it runs, and the suite owns its own database.
    await prisma.users.deleteMany({});
    expect(await isConfirmedSingleUser(prisma)).toBe(true);

    await mkAdmin();
    // ONE user, setting still false. A helper meaning "exactly one user" would
    // answer true here, and the extension middleware would then skip its
    // suspension check.
    expect(await prisma.users.count()).toBe(1);
    expect(await isConfirmedSingleUser(prisma)).toBe(false);
  });

  it("a suspended user's extension key is refused, which is what the coupling protects", async () => {
    // The consequence, asserted through the middleware rather than argued from
    // the helper. With a user row present the guard is entered and the check
    // runs; this test goes red if either half changes.
    const user = await mkAdmin();
    const {
      BrowserExtensionApiKey,
    } = require("../../../models/browserExtensionApiKey");
    const made = await BrowserExtensionApiKey.create(user.id);
    const secret = made.apiKey.key;

    const { User } = require("../../../models/user");
    await User.update(user.id, { suspended: 1 });

    const middleware = require("../../../utils/middleware/validBrowserExtensionApiKey");
    const gate = (middleware.validBrowserExtensionApiKey ?? middleware)(
      "workspace.read"
    );
    const { seen, response, next } = recorder();
    await gate(
      {
        header: (name) =>
          name === "Authorization" ? `Bearer ${secret}` : undefined,
        params: {},
        body: {},
        query: {},
      },
      response,
      next
    );

    expect(seen.nexted).toBe(false);
    expect(seen.status).toBe(403);
  });
});

describe("S12 (d): removeGroupMember has a production caller", () => {
  // Driven over HTTP through the mounted route, with a real signed token. A test
  // that calls `removeGroupMember` directly proves what its own suite already
  // proved — that the repository works — and says nothing about whether an
  // operator can reach it, which is the entire defect: the function was correct
  // and tested for its whole life while every reference to it was a test.
  let app;
  let server;
  let baseUrl;

  beforeAll(async () => {
    const express = require("express");
    const { adminEndpoints } = require("../../../endpoints/admin");
    app = express();
    app.use(express.json());
    adminEndpoints(app);
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  }, 60000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const setup = async () => {
    const admin = await mkAdmin();
    const member = await mkAdmin();
    const group = await prisma.groups.create({
      data: { name: `s12-group-${seq++}`, orgId: 1 },
    });
    await prisma.group_members.create({
      data: { group_id: group.id, user_id: member.id },
    });
    return { admin, member, group };
  };

  const call = (token, group, member) =>
    fetch(`${baseUrl}/admin/group/${group.id}/member/${member.id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("an operator holding user.manage can remove a member", async () => {
    const { admin, member, group } = await setup();
    const { makeJWT } = require("../../../utils/http");
    const token = makeJWT({ id: admin.id, username: admin.username });

    expect(
      await prisma.group_members.count({ where: { user_id: member.id } })
    ).toBe(1);

    // M4b: the row disappearing is not the whole contract. `removeGroupMember`
    // bumps a policy version and publishes `policy.changed` in the SAME
    // transaction (the outbox pattern), which is what tells every cache the
    // membership is gone. A test that only checks the delete passes on a
    // handler that calls `prisma.group_members.deleteMany` directly — leaving
    // every cached decision serving the removed member until its TTL expires.
    //
    // Counted BY TYPE across the call, not by "one more row": outbox ids are
    // uuids rather than ordered, and `auth.key_used` fires concurrently from
    // other suites in a --runInBand process, so a total count is a flake.
    const versionsBefore = await prisma.policy_versions.count();
    const changedBefore = await prisma.event_outbox.count({
      where: { type: "policy.changed" },
    });

    const response = await call(token, group, member);
    expect(response.status).toBe(200);
    expect(
      await prisma.group_members.count({ where: { user_id: member.id } })
    ).toBe(0);

    expect(await prisma.policy_versions.count()).toBe(versionsBefore + 1);
    expect(
      await prisma.event_outbox.count({ where: { type: "policy.changed" } })
    ).toBe(changedBefore + 1);
    const latest = await prisma.policy_versions.findFirst({
      orderBy: { version: "desc" },
    });
    expect(latest.change_type).toBe("group_membership");
  });

  it("F4a: a NONEXISTENT group is 404, and bumps no policy version", async () => {
    // Measured: `groupId` 999999 answered 200 and bumped a version.
    // `removeGroupMember`'s `deleteMany` is a no-op on an empty set — by design,
    // removing a non-member is not an error — but the version bump runs first
    // and unconditionally, and `workspaceScopeKeysFor` falls back to `orgId ?? 1`
    // when it finds nothing, so the bump publishes under `org:1` and invalidates
    // every cached decision in the instance. An unauthenticated-shaped typo
    // becomes a cache flush.
    //
    // `after === before` across the call, so a 404 that still bumps stays red.
    const { admin } = await setup();
    const { makeJWT } = require("../../../utils/http");
    const token = makeJWT({ id: admin.id, username: admin.username });
    const before = await prisma.policy_versions.count();

    const response = await fetch(
      `${baseUrl}/admin/group/999999/member/${admin.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );

    expect(response.status).toBe(404);
    expect(await prisma.policy_versions.count()).toBe(before);
  });

  it("F4b: a NON-NUMERIC groupId is 404, not 500", async () => {
    // A different failure from F4a and it needs a different fix: `Number("abc")`
    // is NaN, which throws inside the repository before any write — so this one
    // never bumped, and an existence check alone would not stop the 500. Parse
    // first, then check existence.
    const { admin } = await setup();
    const { makeJWT } = require("../../../utils/http");
    const token = makeJWT({ id: admin.id, username: admin.username });
    const before = await prisma.policy_versions.count();

    const response = await fetch(
      `${baseUrl}/admin/group/abc/member/${admin.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );

    expect(response.status).toBe(404);
    expect(await prisma.policy_versions.count()).toBe(before);
  });

  it("F5: a DELETED user's key is refused, with no sweep involved", async () => {
    // TL-2 security-review HIGH. `User.delete` is a bare `deleteMany` on `users`
    // and neither `api_keys.createdBy` nor `principal_role_grants.principal_id`
    // has a foreign key (measured in the S12 recon), so the key row and the
    // grant row both outlive their owner — and `validApiKey` resolves a key as
    // `grants(createdBy) ∩ scopes(key)`. A deleted super_admin's key kept
    // authenticating with their grants.
    //
    // Nothing sweeps on delete, and nothing here adds one: what closes it is the
    // reader refusing a creator whose row is gone. This is a SEPARATE fixture
    // from D3 because D3 drives the resolver with a stub, and this drives the
    // real delete path end to end.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "f5-deleted-owner");

    // authenticates while the owner exists
    expect((await authenticate(apiKey.secret)).nexted).toBe(true);

    // Through the REAL route, not `User.delete`. QA-2 D6: the fixture has to
    // exercise the path an operator actually takes, because that is where a
    // future sweep would be added and where its absence has to be visible.
    const { makeJWT } = require("../../../utils/http");
    const operator = await mkAdmin();
    const deleted = await fetch(`${baseUrl}/admin/user/${user.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${makeJWT({ id: operator.id, username: operator.username })}`,
      },
    });
    expect(deleted.status).toBe(200);

    // The key row survives with `createdBy` DANGLING — still holding the id,
    // which now points at no row. That is the state this fixture is about, and
    // it is distinct from `createdBy: null` (D1's single-user path, which must
    // still ALLOW). Asserted rather than assumed, because nulling the column by
    // hand would quietly turn this into D3's shape and test nothing new.
    const orphan = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    expect(orphan).not.toBeNull();
    expect(orphan.createdBy).toBe(user.id);
    expect(
      await prisma.users.findUnique({ where: { id: user.id } })
    ).toBeNull();
    // BOTH layers, per TL-2. The sweep stamped `revokedAt` before the owner row
    // vanished — the investigator's record of when the key died, which no query
    // can reconstruct afterwards — and the row itself is KEPT rather than
    // deleted, because that record is the point.
    expect(orphan.revokedAt).not.toBeNull();

    // ...and it no longer authenticates. The reader is what enforces this: it
    // refuses a creator whose row is gone, and would refuse even if the stamp
    // above had not been written.
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(false);
    expect([401, 403]).toContain(seen.status);

    await prisma.api_keys.deleteMany({ where: { createdBy: user.id } });
    await prisma.principal_role_grants.deleteMany({
      where: { principal_id: String(user.id) },
    });
  });

  it("an unauthenticated caller cannot, and the membership survives", async () => {
    // The gate assertion has to include the SIDE EFFECT. A route that refuses
    // with 401 after already deleting the row would pass a status-only check.
    const { member, group } = await setup();
    const response = await call(null, group, member);
    expect(response.status).not.toBe(200);
    expect(
      await prisma.group_members.count({ where: { user_id: member.id } })
    ).toBe(1);
  });
});

describe("S12 QA-2: suspension must be enforced at the READER, not only at the sweep", () => {
  // `User.update` revokes the keys it can see at the moment it runs. That is a
  // SWEEP, and a sweep is only as good as its coverage — `resolveActor`'s
  // api-key branch never reads `users.suspended`, so any key the sweep did not
  // touch still authenticates for a suspended creator.
  //
  // Measured on `dba30b6ac`, all three paths returning `next(): true` with no
  // status:
  //
  //   _update(id, {suspended: 1})            bypasses `update` entirely
  //   ApiKey.create for a suspended user     the sweep already ran
  //   re-suspend an already-suspended user   `isSuspending` is false, no sweep
  //
  // Every assertion below is on the MIDDLEWARE's answer. Asserting `revokedAt`
  // would pass on a fix that writes the column and never consults it, and the
  // whole finding is that the column is not what the reader checks.
  it("QA2-1: a key minted for an ALREADY-suspended user does not authenticate", async () => {
    // PMO's fixture (1) named `POST /admin/generate-api-key` with a suspended
    // TARGET. That route is not reachable that way: `admin.js:793` mints for
    // `user.id` — the SESSION user — and `validatedRequest` refuses a suspended
    // session, so no HTTP caller can name a suspended target. Measured before
    // writing this, rather than asserting a path that does not exist.
    //
    // The reachable shape is the model call the route wraps, which is also what
    // any future admin-mints-for-user route would use. Either the create is
    // refused or the key must not authenticate; both are correct outcomes, and
    // the assertion allows either rather than dictating the fix's shape.
    const user = await mkAdmin();
    const { User } = require("../../../models/user");
    await User.update(user.id, { suspended: 1 });

    const { apiKey, error } = await keyFor(user, "qa2-minted-while-suspended");
    if (error || !apiKey) {
      expect(error).toBeTruthy(); // refused at creation: acceptable
      return;
    }
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(false);
    expect([401, 403]).toContain(seen.status);
  });

  it("QA2-2: _update(suspended) leaves no authenticating key", async () => {
    // `User._update` writes the column directly and never runs the sweep. It is
    // a real code path — `models/user.js:285`, used where a caller wants the row
    // back — so a guard that lives only in `update` is a guard with a documented
    // way around it.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "qa2-underscore-update");
    const { User } = require("../../../models/user");
    await User._update(user.id, { suspended: 1 });

    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(false);
    expect([401, 403]).toContain(seen.status);
  });

  it("QA2-3: re-suspending an already-suspended user leaves no authenticating key", async () => {
    // `isSuspending` is `updates.suspended === 1 && currentUser.suspended !== 1`,
    // so the second suspend sweeps nothing. A key minted between the two
    // survives, and the operator's second attempt reports success.
    const user = await mkAdmin();
    const { User } = require("../../../models/user");
    await User.update(user.id, { suspended: 1 });

    const { apiKey, error } = await keyFor(user, "qa2-between-suspends");
    const again = await User.update(user.id, { suspended: 1 });
    expect(again.success).toBe(true); // the operator is told it worked

    // Shape-agnostic, like QA2-1: once the resolver refuses a suspended
    // creator, `ApiKey.create`'s existing ceiling check can no longer resolve
    // one, so the mint fails and there is no key to present. Either outcome
    // closes the hole — what must not happen is a key that authenticates.
    if (error || !apiKey) {
      expect(error).toBeTruthy();
    } else {
      const seen = await authenticate(apiKey.secret);
      expect(seen.nexted).toBe(false);
      expect([401, 403]).toContain(seen.status);
    }

    // The level-triggered half, asserted independently of the mint: a key that
    // existed BEFORE the first suspend must carry a `revokedAt`, and a second
    // suspend must not disturb it. This is what goes red if the sweep reverts
    // to edge-triggered.
    // The level-triggered half, asserted on the SWEEP rather than on
    // authentication. Authentication cannot see it: `keyGrantPrincipal` now
    // refuses a suspended creator, so the key is dead either way and an
    // edge-triggered sweep passes every reachability test. Measured — reverting
    // (b) alone left all 14 green until this assertion existed.
    //
    // What the sweep still owes is the AUDIT RECORD. A key that appears while
    // the user is already suspended must still end up stamped, and only a
    // level-triggered sweep stamps it.
    const earlier = await mkAdmin();
    await User.update(earlier.id, { suspended: 1 });
    // A key written directly, as a restore or an out-of-band job would: the
    // model refuses to mint for a suspended creator now, so this is the shape
    // that reaches the second sweep.
    const orphan = await prisma.api_keys.create({
      data: {
        name: "qa2-appeared-after-suspend",
        secretDigest: Buffer.from(`qa2-${seq++}-${Date.now()}`),
        keyPrefix: "apw-key-qa2",
        scopes: JSON.stringify(["workspace.read"]),
        createdBy: earlier.id,
      },
    });
    expect(orphan.revokedAt).toBeNull();

    const again2 = await User.update(earlier.id, { suspended: 1 });
    expect(again2.success).toBe(true);

    const stamped = await prisma.api_keys.findUnique({
      where: { id: orphan.id },
    });
    expect(stamped.revokedAt).not.toBeNull();
  });

  it("QA2-5: CONTROL — a creatorless key in SINGLE-USER mode still authenticates", async () => {
    // The control TL-2 required, and the one the reader-side check could
    // plausibly break. `endpoints/system.js` mints keys with
    // `ApiKey.create(null, name)`: in a single-user deployment there are no user
    // rows to attribute a key to, so EVERY key ever issued there has a null
    // creator. `keyGrantPrincipal`'s comment (:236-245) warns that denying those
    // takes the whole /v1 surface offline on upgrade, for the deployments least
    // able to diagnose it.
    //
    // The new suspension lookup sits inside the `creatorId !== null` branch for
    // exactly that reason — this test is what stops it from being hoisted.
    const { SystemSettings } = require("../../../models/systemSettings");
    await prisma.system_settings.upsert({
      where: { label: "multi_user_mode" },
      update: { value: "false" },
      create: { label: "multi_user_mode", value: "false" },
    });
    const restore = await prisma.users.findMany();
    await prisma.users.deleteMany({});
    try {
      expect(await SystemSettings.isMultiUserMode()).toBe(false);
      const { ApiKey } = require("../../../models/apiKeys");
      const { apiKey, error } = await ApiKey.create(null, "qa2-creatorless", {
        scopes: ["workspace.read"],
      });
      expect(error).toBeFalsy();
      const seen = await authenticate(apiKey.secret);
      expect(seen.nexted).toBe(true);
      expect(seen.status).toBeNull();
    } finally {
      for (const user of restore)
        await prisma.users.create({ data: user }).catch(() => {});
    }
  });

  it("M5: an already-revoked key keeps its ORIGINAL revokedAt", async () => {
    // The audit promise the sweep exists to keep. `revokedAt` says WHEN a key
    // stopped working; re-stamping it on a later suspension rewrites that, and
    // the `revokedAt: null` filter is the only thing preventing it.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "m5-early-revoke");
    const stamped = new Date("2020-01-01T00:00:00.000Z");
    await prisma.api_keys.updateMany({
      where: { createdBy: user.id },
      data: { revokedAt: stamped },
    });

    const { User } = require("../../../models/user");
    await User.update(user.id, { suspended: 1 });

    const row = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    expect(row.revokedAt).toEqual(stamped);
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(false);
  });

  it("M6: BLAST RADIUS — suspending one user does not revoke another's key", async () => {
    // The filter is `createdBy: <this user>`. Without it the sweep revokes every
    // live key in the instance, which no test above would notice: they all check
    // that the SUSPENDED user's key stopped working, and a sweep that revokes
    // everything satisfies every one of them.
    const victim = await mkAdmin();
    const bystander = await mkAdmin();
    const { apiKey: bystanderKey } = await keyFor(bystander, "m6-bystander");
    await keyFor(victim, "m6-victim");

    const { User } = require("../../../models/user");
    await User.update(victim.id, { suspended: 1 });

    const bystanderRow = await prisma.api_keys.findFirst({
      where: { createdBy: bystander.id },
    });
    expect(bystanderRow.revokedAt).toBeNull();
    const seen = await authenticate(bystanderKey.secret);
    expect(seen.nexted).toBe(true);
    expect(seen.status).toBeNull();
  });

  it("D5: un-suspending does NOT revive a revoked key", async () => {
    // Revocation is permanent. Reviving old secrets on un-suspension would mean a
    // credential that may have been copied while the account was suspended
    // silently works again; the restored user mints a new key instead.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "d5-revive");
    const { User } = require("../../../models/user");

    await User.update(user.id, { suspended: 1 });
    const revokedAt = (
      await prisma.api_keys.findFirst({ where: { createdBy: user.id } })
    ).revokedAt;
    expect(revokedAt).not.toBeNull();

    await User.update(user.id, { suspended: 0 });
    const after = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    // Not cleared, and not re-stamped.
    expect(after.revokedAt).toEqual(revokedAt);

    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(false);
    expect([401, 403]).toContain(seen.status);

    // ...while the user themselves is active again, so this is about the KEY and
    // not about the account still being refused.
    const row = await prisma.users.findUnique({ where: { id: user.id } });
    expect(row.suspended).toBe(0);
  });

  it("UNREADABLE: a db that cannot answer about the creator denies, and does not throw", async () => {
    // The degrade path, which is otherwise an untested guard. `resolveActor`
    // accepts an injected db, and several suites pass a stub carrying only the
    // tables they care about. The first version of this fix assumed
    // `users.findUnique` exists and threw a TypeError from inside the resolver —
    // 39 failures across 7 suites, and a throw is not failing closed, it is
    // failing loudly somewhere else.
    const {
      resolveActor,
    } = require("../../../utils/authorization/actorResolver");
    const narrowDb = {
      api_keys: { findUnique: async () => ({ createdBy: 5 }) },
      users: { count: async () => 3 }, // no findUnique
      workspace_users: { findMany: async () => [] },
    };
    const actor = await resolveActor(
      { params: {} },
      {
        locals: {
          apiKeyContext: {
            keyId: 7,
            keyPrefix: "apw-key-x",
            scopes: ["workspace.read"],
            workspaceId: null,
            keyKind: "api-key",
          },
        },
      },
      { db: narrowDb }
    );
    // Resolved without throwing, and with NO grant principal — the engine then
    // denies for want of grants.
    expect(actor).toMatchObject({ type: "service", id: "api-key:7" });
    expect(actor.grantPrincipal).toBeNull();
  });

  it("THREE STATES: null allows, dangling refuses, present is checked — asserted side by side", async () => {
    // TL-2: all three explicitly, not two plus inference. They are three
    // different answers from one function, and collapsing any pair is a
    // fail-open or an outage:
    //
    //   createdBy null      -> SINGLE_USER principal. A single-user deployment
    //                          has no user rows, so EVERY key it ever issued has
    //                          a null creator; refusing these takes /v1 offline.
    //   createdBy dangling  -> refuse. The owner row is gone.
    //   createdBy present   -> refuse iff suspended.
    const {
      resolveActor,
      SINGLE_USER_ACTOR,
    } = require("../../../utils/authorization/actorResolver");
    const context = {
      keyId: 7,
      keyPrefix: "apw-key-x",
      scopes: ["workspace.read"],
      workspaceId: null,
      keyKind: "api-key",
    };
    const resolve = (createdBy, userRow, userCount) =>
      resolveActor(
        { params: {} },
        { locals: { apiKeyContext: context } },
        {
          db: {
            api_keys: { findUnique: async () => ({ createdBy }) },
            users: { count: async () => userCount, findUnique: async () => userRow },
            workspace_users: { findMany: async () => [] },
          },
        }
      );

    // null creator, single-user deployment (zero user rows): ALLOWED
    const single = await resolve(null, null, 0);
    expect(single.grantPrincipal).toEqual({
      type: SINGLE_USER_ACTOR.type,
      id: SINGLE_USER_ACTOR.id,
    });

    // dangling creator: REFUSED
    expect((await resolve(4242, null, 3)).grantPrincipal).toBeNull();

    // present and suspended: REFUSED
    expect((await resolve(5, { suspended: 1 }, 3)).grantPrincipal).toBeNull();

    // present and active: ALLOWED, as the creator
    expect((await resolve(5, { suspended: 0 }, 3)).grantPrincipal).toEqual({
      type: "user",
      id: "5",
    });
  });

  it("D3: a key whose creator was DELETED is refused, and not read as unsuspended", async () => {
    // The three denial conditions must stay distinct. Collapsing "no user found"
    // into "not suspended" is the exact fail-open QA-2 warned about: a key
    // outlives its creator (`api_keys.createdBy` has no foreign key — measured
    // in the S12 recon), so the row really can be gone.
    //
    // Asserted through the resolver rather than the middleware, because
    // `ApiKey.validate` has its own opinions and this is about which principal
    // the grants resolve against.
    const {
      resolveActor,
    } = require("../../../utils/authorization/actorResolver");
    const deletedCreatorDb = {
      api_keys: { findUnique: async () => ({ createdBy: 4242 }) },
      users: { count: async () => 3, findUnique: async () => null },
      workspace_users: { findMany: async () => [] },
    };
    const actor = await resolveActor(
      { params: {} },
      {
        locals: {
          apiKeyContext: {
            keyId: 7,
            keyPrefix: "apw-key-x",
            scopes: ["workspace.read"],
            workspaceId: null,
            keyKind: "api-key",
          },
        },
      },
      { db: deletedCreatorDb }
    );
    expect(actor).toMatchObject({ type: "service", id: "api-key:7" });
    expect(actor.grantPrincipal).toBeNull();
  });

  it("F1: an UN-suspend sent as a string does not suspend, and does not revoke", async () => {
    // BLOCKER. `castColumnValue` was `Number(Boolean(value))`, and every
    // non-empty string is truthy — so `{"suspended": "0"}` and
    // `{"suspended": "false"}`, which is what a JSON client sends, both cast to
    // 1. Combined with permanent revocation that is unrecoverable: an operator
    // clicking "un-suspend" would suspend the account again AND destroy every
    // key the user has, with no way to bring them back.
    //
    // Measured before the fix: "0" -> 1, "false" -> 1.
    const { User } = require("../../../models/user");
    for (const [input, expected] of [
      ["0", 0],
      ["false", 0],
      [0, 0],
      [false, 0],
      [1, 1],
      ["1", 1],
      ["true", 1],
      [true, 1],
    ])
      expect(User.castColumnValue("suspended", input)).toBe(expected);

    // Anything outside the set REFUSES rather than defaulting. Measured on the
    // old cast: "no", "[]" and "0.0" all became 1 — silently suspending on input
    // that means nothing. Defaulting to 0 instead would silently ignore a
    // suspend the operator asked for; both are wrong in a way the caller cannot
    // see. The cast RETURNS the refusal (null); `update` is what answers.
    for (const bad of ["no", "[]", "0.0", "", "yes", 2, -1, null, undefined, [], {}])
      expect(User.castColumnValue("suspended", bad)).toBeNull();

    // The refusal reaches the caller as an answer, and — the part that matters —
    // the USER STAYS ACTIVE and their key stays valid. QA-2 F1c measured the old
    // behaviour: `{"suspended": "banana"}` and `{"suspended": "2"}` both
    // answered 200 with the row set to 1 and every key revoked PERMANENTLY, off
    // a value that means nothing.
    //
    // A rejected value arriving at prisma as `undefined` would be SKIPPED,
    // returning success with nothing changed — which reads as a suspend that
    // worked — so the row and the key are asserted, never the envelope.
    for (const bad of ["banana", "2", "-1", "null", "undefined"]) {
      const subject = await mkAdmin();
      const { apiKey: subjectKey } = await keyFor(subject, `f1c-${bad}`);

      const refused = await User.update(subject.id, { suspended: bad });
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/suspended/);

      const row = await prisma.users.findUnique({ where: { id: subject.id } });
      expect(row.suspended).toBe(0);
      const key = await prisma.api_keys.findFirst({
        where: { createdBy: subject.id },
      });
      expect(key.revokedAt).toBeNull();
      expect((await authenticate(subjectKey.secret)).nexted).toBe(true);
    }

    // CONTROLS: the four spellings the frontend actually sends still work.
    for (const [input, expected] of [
      [1, 1],
      [true, 1],
      [0, 0],
      [false, 0],
    ]) {
      const subject = await mkAdmin();
      const { success } = await User.update(subject.id, { suspended: input });
      expect(success).toBe(true);
      const row = await prisma.users.findUnique({ where: { id: subject.id } });
      expect(row.suspended).toBe(expected);
    }

    // CONTROL: the shared switch still handles its other cases. A malformed
    // dailyMessageLimit stores null rather than throwing — that column's rule is
    // not this column's rule.
    expect(User.castColumnValue("dailyMessageLimit", null)).toBeNull();

    // and end to end: a key survives an un-suspend sent as a string
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "f1-string-unsuspend");
    await User.update(user.id, { suspended: "0" });

    const row = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    expect(row.revokedAt).toBeNull();
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(true);
  });

  it("F2: changing an unrelated field does not revoke the user's keys", async () => {
    // The sweep is level-triggered on `updates.suspended === 1`. A mutant that
    // hardcodes `isSuspending = true` fires on every update — so a role change,
    // a rename, a bio edit would each destroy the user's keys. Nothing else here
    // notices: every other test either suspends or never updates at all.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "f2-role-change");
    const { User } = require("../../../models/user");

    // `bio`, not `role`. A role change legitimately moves the legacy grant, so
    // the key would stop authorizing for a reason that has nothing to do with
    // revocation — the first version of this test used `role` and went red
    // against correct code, which would have read as a defect in the sweep.
    const { success } = await User.update(user.id, { bio: "still here" });
    expect(success).toBe(true);

    const row = await prisma.api_keys.findFirst({
      where: { createdBy: user.id },
    });
    expect(row.revokedAt).toBeNull();
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(true);
  });

  it("F3: a key that existed BEFORE the suspend is not revoked for another user", async () => {
    // The blast-radius test M6 could not catch. M6 mints the bystander's key
    // and the victim's key and then suspends — but a mutant dropping
    // `revokedAt: null` from the filter still only touches rows matching
    // `createdBy`, so M6 passes. What that mutant breaks is the FILTER's other
    // half, and the shape that shows it is a key belonging to someone else that
    // predates the suspension entirely.
    const bystander = await mkAdmin();
    const { apiKey: bystanderKey } = await keyFor(bystander, "f3-pre-existing");
    // ...time passes, an unrelated user is offboarded...
    const victim = await mkAdmin();
    await keyFor(victim, "f3-victim");
    const { User } = require("../../../models/user");
    await User.update(victim.id, { suspended: 1 });

    const row = await prisma.api_keys.findFirst({
      where: { createdBy: bystander.id },
    });
    expect(row.revokedAt).toBeNull();
    const seen = await authenticate(bystanderKey.secret);
    expect(seen.nexted).toBe(true);
    expect(seen.status).toBeNull();
  });

  it("QA2-4: CONTROL — an unsuspended owner's key still authenticates", async () => {
    // Without this, refusing every key passes all three tests above.
    const user = await mkAdmin();
    const { apiKey } = await keyFor(user, "qa2-control");
    const seen = await authenticate(apiKey.secret);
    expect(seen.nexted).toBe(true);
    expect(seen.status).toBeNull();
  });
});
