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

    const response = await call(token, group, member);
    expect(response.status).toBe(200);
    expect(
      await prisma.group_members.count({ where: { user_id: member.id } })
    ).toBe(0);
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
