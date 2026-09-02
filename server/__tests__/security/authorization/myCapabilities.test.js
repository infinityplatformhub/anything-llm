/**
 * T-7 (#31 D-1, #40A): GET /system/my-capabilities.
 *
 * Answers "what may THIS caller do", replacing the instance-wide flag the UI
 * read before. It gates affordances only — every route re-decides on its own,
 * so these tests assert the answer tracks grants, not that it protects anything.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-caps-")
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
const testDb = `t7_caps_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

// Unique per run: utils/prisma is required by many suites and NODE_ENV/test
// binding means a fixed id can collide with a sibling suite's database.
const ACTOR = { id: 7000 + (process.pid % 900) };

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    response.locals.user = {
      id: 7000 + (process.pid % 900),
      suspended: 0,
    };
    next();
  },
}));

let prisma;
let server;
let baseUrl;
let repository;
let roles;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("T-7 integration tests require DATABASE_URL on PostgreSQL");
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

  // Use the SHARED client, not a second one: the endpoint under test resolves
  // utils/prisma, so a separate PrismaClient would have the test writing to one
  // database while the route read another — and every capability would come
  // back false, which looks exactly like a correct deny.
  // utils/prisma is a SINGLETON that binds DATABASE_URL at first require. Another
  // suite in this process (jest --runInBand shares one) may already have loaded it
  // against the shared database, in which case every write below would land there
  // instead of in this suite's own — and the tests still pass, because they only
  // ever read back what they wrote. The leaked users then break OTHER suites:
  // `isConfirmedSingleUser` counts real rows, so actorResolver R5 goes red in a
  // branch that never touched it. Reset first so the require below is OURS.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  await prisma.users.create({
    data: { id: ACTOR.id, username: `caps-${dbSuffix}`, password: "unused" },
  });
  roles = {
    member: await prisma.roles.findFirstOrThrow({
      where: { name: "member", scope: "org" },
    }),
    moderator: await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    }),
  };
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(ACTOR.id),
    roleId: roles.member.id,
    db: prisma,
  });

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
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const capabilities = async () =>
  (await fetch(`${baseUrl}/system/my-capabilities`).then((r) => r.json()))
    .capabilities;

describe("GET /system/my-capabilities", () => {
  test("a plain member holds none of the org capabilities", async () => {
    const caps = await capabilities();
    expect(caps["chat.read_others"]).toBe(false);
    expect(caps["user.manage"]).toBe(false);
    // Present-and-false, not absent: the UI must be able to tell "denied" from
    // "the server did not answer".
    expect(Object.keys(caps)).toEqual(expect.arrayContaining(["settings.write"]));
  });

  test("granting a role flips the capability on the next call — no cache to wait for", async () => {
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(ACTOR.id),
      roleId: roles.moderator.id,
      db: prisma,
    });

    const caps = await capabilities();
    expect(caps["chat.read_others"]).toBe(true);
    // content_moderator carries read_others but not user administration.
    expect(caps["user.manage"]).toBe(false);
  });

  test("it reports only the fixed list, never the whole vocabulary", async () => {
    const caps = await capabilities();
    const seeded = require("../../../prisma/seeds/permissions").ALL_ACTIONS;
    expect(Object.keys(caps).length).toBeLessThan(seeded.length);
    // An endpoint that enumerated everything would hand any caller a map of the
    // permission model.
    expect(caps).not.toHaveProperty("role.grant");
  });
});

describe("delegated admin: assigning a role you do not hold (T-7)", () => {
  const {
    canAssignLegacyRole,
  } = require("../../../utils/authorization/policyRepository");

  test("a content_moderator cannot mint an admin", async () => {
    // The old helper compared role strings in a fixed hierarchy, so anyone
    // whose legacy role read "admin" could assign "admin". The question is now
    // the escalation guard: you may hand over only what you already hold.
    const actor = { type: "user", id: String(ACTOR.id), orgId: 1 };
    await expect(
      canAssignLegacyRole({ actor, targetRole: "admin", db: prisma })
    ).resolves.toBe(false);
  });

  test("a super_admin can", async () => {
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    const boss = await prisma.users.create({
      data: { username: `boss-${dbSuffix}`, password: "unused", role: "admin" },
    });
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(boss.id),
      roleId: superAdmin.id,
      db: prisma,
    });

    await expect(
      canAssignLegacyRole({
        actor: { type: "user", id: String(boss.id), orgId: 1 },
        targetRole: "admin",
        db: prisma,
      })
    ).resolves.toBe(true);
  });

  test("a null actor assigns nothing", async () => {
    await expect(
      canAssignLegacyRole({ actor: null, targetRole: "default", db: prisma })
    ).resolves.toBe(false);
  });
});
