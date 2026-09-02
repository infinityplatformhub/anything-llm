/**
 * T-7 (#31): S-20 — an admin without `chat.read_others` cannot read another
 * user's chats through ANY route.
 *
 * The point of the test is the word ANY. `chat.read_others` was a single env
 * kill switch, so it only ever had to be checked in one place; as a
 * per-principal permission it has to hold on every route that reaches other
 * people's conversations, and a route that forgets is not visible from reading
 * any single file. These drive the real HTTP surface with a real admin token —
 * a legacy `role: "admin"` who holds no grant, which is precisely the actor the
 * old role check would have waved through.
 *
 * The `/v1` leg is the third describe block. It needs T-4b's W-8 (the grant half
 * of `validApiKey`), which arrived in this branch's base at the rebase — before
 * that, a test here would have passed against code that was not present.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-readothers-")
  );
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

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
const testDb = `t7_readothers_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
let plainAdminToken;
let moderatorToken;
let readerOnlyToken;
let exporterToken;
let plainKeySecret;
let adminKeySecret;
let roles = {};

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
  prisma = require("../../../utils/prisma");

  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  const { makeJWT } = require("../../../utils/http");

  for (const name of ["content_moderator", "member", "super_admin"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: { name, scope: "org" },
    });
  }

  const mkUser = (label, role) =>
    prisma.users.create({
      data: { username: `ro-${label}-${dbSuffix}`, password: "unused", role },
    });
  const grant = (userId, roleId) =>
    repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(userId),
      roleId,
      db: prisma,
    });

  // A legacy admin holding only `member`. Under the old role check this user
  // read everyone's chats; the whole of T-4a was removing that shortcut.
  const plainAdmin = await mkUser("admin", "admin");
  await grant(plainAdmin.id, roles.member.id);
  plainAdminToken = makeJWT({ id: plainAdmin.id, username: plainAdmin.username });

  // Holds chat.read_others but NOT document.bulk_export.
  const moderator = await mkUser("mod", "default");
  await grant(moderator.id, roles.content_moderator.id);
  moderatorToken = makeJWT({ id: moderator.id, username: moderator.username });

  // Holds chat.read_others and NOT document.bulk_export. `content_moderator`
  // carries both, so it cannot show that the export route needs the second one
  // — the D-2 negative needs a principal that has exactly one of them.
  const readerOnlyRole = await prisma.roles.create({
    data: { orgId: 1, name: `reader-only-${dbSuffix}`, scope: "org" },
  });
  const readOthers = await prisma.permissions.findFirstOrThrow({
    where: { action: "chat.read_others" },
  });
  await prisma.role_permissions.create({
    data: { role_id: readerOnlyRole.id, permission_id: readOthers.id, effect: "allow" },
  });
  const readerOnly = await mkUser("reader", "default");
  await grant(readerOnly.id, readerOnlyRole.id);
  readerOnlyToken = makeJWT({ id: readerOnly.id, username: readerOnly.username });

  // Holds both.
  const exporter = await mkUser("exp", "default");
  await grant(exporter.id, roles.super_admin.id);
  exporterToken = makeJWT({ id: exporter.id, username: exporter.username });

  // Two API keys carrying the SAME scope and differing only in whose grants
  // stand behind them. Effective permission is grants(creator) INTERSECT
  // scopes(key), and a test where the scopes differ proves only the scope half.
  const { ApiKey } = require("../../../models/apiKeys");
  const keyScopes = [
    "chat.read",
    "document.bulk_export",
    "workspace.read",
    "system.read",
  ];
  plainKeySecret = (
    await ApiKey.create(plainAdmin.id, "plain-admin key", { scopes: keyScopes })
  ).apiKey.secret;
  adminKeySecret = (
    await ApiKey.create(exporter.id, "super-admin key", { scopes: keyScopes })
  ).apiKey.secret;

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const { systemEndpoints } = require("../../../endpoints/system");
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
  // The /v1 surface mounts on its own router, exactly as index.js wires it —
  // the grant half lives inside validApiKey, so the routes have to be real.
  const { apiAdminEndpoints } = require("../../../endpoints/api/admin");
  const { apiSystemEndpoints } = require("../../../endpoints/api/system");
  const v1Router = express.Router();
  apiAdminEndpoints(v1Router);
  apiSystemEndpoints(v1Router);
  app.use("/", v1Router);
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

// workspace-chats is a POST (it takes an offset in the body); export-chats is a
// GET. The route table decides the verb, not the test's convenience — a GET to a
// POST route answers 404, which is how the first run of this suite read as a
// clean refusal when nothing had been checked at all.
const call = (method, route, token, body) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });

const OTHERS_CHAT_ROUTES = [
  ["POST", "/system/workspace-chats"],
  ["GET", "/system/export-chats"],
];

describe("S-20: chat.read_others holds on every route that reaches other people's chats", () => {
  test("a legacy admin without the grant is refused on every such route", async () => {
    for (const [method, route] of OTHERS_CHAT_ROUTES) {
      const res = await call(method, route, plainAdminToken);
      expect(res.status).toBe(403);
      // The body, not only the status: this asserts the refusal came from
      // requirePermission and not from some other 403 on the way in.
      expect((await res.json()).error).toBe("Forbidden.");
    }
  });

  test("the grant is what opens it, not the legacy role column", async () => {
    // Same permission, and this user's users.role is "default" — the weaker of
    // the two by the old hierarchy. If this passes while the case above fails,
    // the decision is coming from the grant.
    expect(
      (await call("POST", "/system/workspace-chats", moderatorToken)).status
    ).toBe(200);
  });

  test("D-2: export needs BOTH chat.read_others and document.bulk_export", async () => {
    // A moderator may read other people's chats one at a time and may not
    // bulk-extract them. Requiring only the export permission would let someone
    // with no right to read a single conversation download all of them.
    expect(
      (await call("GET", "/system/export-chats", readerOnlyToken)).status
    ).toBe(403);
    expect(
      (await call("GET", "/system/export-chats", exporterToken)).status
    ).toBe(200);
  });
});

describe("S-20 over /v1: the scope half is not the whole answer", () => {
  const v1 = (method, route, secret) =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
    });

  const V1_OTHERS_CHAT_ROUTES = [
    ["POST", "/v1/admin/workspace-chats"],
    ["GET", "/v1/system/export-chats"],
  ];

  test("a key whose creator lacks the grant is refused, though its scopes permit it", async () => {
    // Both keys carry identical scopes. The only difference is whose grants
    // stand behind them, so a refusal here can only come from the grant half —
    // which is the whole claim of S-20 on this surface.
    for (const [method, route] of V1_OTHERS_CHAT_ROUTES) {
      const res = await v1(method, route, plainKeySecret);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Insufficient scope.");
    }
  });

  test("the same scopes behind a super_admin creator are allowed", async () => {
    // The positive control. Without it, the case above passes just as well
    // against a /v1 surface that refuses everyone.
    for (const [method, route] of V1_OTHERS_CHAT_ROUTES) {
      expect((await v1(method, route, adminKeySecret)).status).toBe(200);
    }
  });
});
