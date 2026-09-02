// S11a (#80) — mailing an invite, over the real HTTP stack.
//
// RED-first: written before the routes accept an address.
//
// Ruling D draws a line the existing permission model does not: `invite.create`
// lets someone mint a link they then hand over themselves, which is auditable
// and slow. Mailing is different — it reaches an arbitrary address chosen by the
// caller, from the deployment's own domain and reputation. So sending requires
// `user.manage`, and a caller with only `invite.create` keeps the copy-link
// behaviour they already had rather than being refused outright.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-mail-"));
const schema = `invite_mail_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql:"))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.API_KEY_PEPPER = "http-test-api-key-pepper-32-bytes";
process.env.SIG_KEY = "test-sig-key-at-least-32-characters-long";
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../../.."), env: process.env, stdio: "ignore" }
);
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../../../prisma/seed.js")],
  { cwd: path.resolve(__dirname, "../../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../../utils/logger", () => () => {});
jest.mock("../../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../../../utils/prisma");
const { app } = require("../../../index");
const { makeJWT } = require("../../../utils/http");
const {
  resetRequestControls,
} = require("../../../utils/middleware/requestControls");
const { startSmtpFixture } = require("../../../__testHelpers__/smtp/server");

let adminAuth;
let managerAuth;
let fixture;

async function grantLegacyRole(user) {
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
}

async function makeUser(username, role) {
  const user = await prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
  });
  await grantLegacyRole(user);
  return `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
}

/**
 * A caller holding `invite.create` and NOT `user.manage`.
 *
 * No seeded role has that combination — `super_admin` holds both and every other
 * role holds neither — so the distinction ruling D draws would otherwise be
 * untestable: a `manager` is refused by the middleware before the mail check is
 * reached, and a test asserting 403 would pass without the rule existing at all.
 * This grants the one action directly, so the 403 below can only come from the
 * mail check.
 */
async function makeMinterOnly(username) {
  const user = await prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role: "default" },
  });
  const role = await prisma.roles.create({
    data: { name: `minter-${process.pid}`, scope: "org" },
  });
  const permission = await prisma.permissions.findFirst({
    where: { action: "invite.create" },
  });
  await prisma.role_permissions.create({
    data: { role_id: role.id, permission_id: permission.id },
  });
  await prisma.principal_role_grants.create({
    data: {
      principal_type: "user",
      principal_id: String(user.id),
      role_id: role.id,
    },
  });
  return `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
}

/** Point the mailer at the fixture and mark that configuration verified. */
async function configureMailer(fixtureServer) {
  const mailerSettings = require("../../../utils/notifications/mailerSettings");
  const config = {
    smtp_host: fixtureServer.host,
    smtp_port: String(fixtureServer.port),
    smtp_secure: "false",
    smtp_allow_insecure: "true",
    smtp_username: "mailer",
    smtp_from_address: "no-reply@example.com",
    smtp_from_name: "ApproofWorkspace",
  };
  process.env.SMTP_PASSWORD = "Sup3rSecret!Mail#2026";
  for (const [label, value] of Object.entries(config))
    await prisma.system_settings.upsert({
      where: { label },
      update: { value },
      create: { label, value },
    });
  const hash = mailerSettings.configHash(config, process.env.SMTP_PASSWORD);
  await prisma.system_settings.upsert({
    where: { label: mailerSettings.VERIFIED_HASH_KEY },
    update: { value: hash },
    create: { label: mailerSettings.VERIFIED_HASH_KEY, value: hash },
  });
}

async function disableMailer() {
  await prisma.system_settings.deleteMany({
    where: { label: { startsWith: "smtp_" } },
  });
  delete process.env.SMTP_PASSWORD;
}

beforeAll(async () => {
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  adminAuth = await makeUser("mail-admin", "admin");
  managerAuth = await makeMinterOnly("mail-minter");
});

beforeEach(async () => {
  await resetRequestControls();
});

afterEach(async () => {
  if (fixture) await fixture.close();
  fixture = undefined;
  await disableMailer();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const newInvite = (auth, body = {}) =>
  request(app)
    .post("/api/admin/invite/new")
    .set("Authorization", auth)
    .send(body);

describe("issue 80: mailing an invite", () => {
  test("an address is accepted, mailed, and the invite records it", async () => {
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: "invitee@example.com",
      workspaceIds: [],
    });

    expect(response.status).toBe(200);
    expect(fixture.messages).toHaveLength(1);

    const stored = await prisma.invites.findUnique({
      where: { id: response.body.invite.id },
    });
    expect(stored.email).toBe("invitee@example.com");
    // Mailed means it expires — the pairing rule, seen from the route.
    expect(stored.expiresAt).not.toBeNull();
  });

  test("the mailed body carries the invite's OWN code", async () => {
    // A link built from the wrong invite is worse than no link: it would work,
    // and grant whatever the other invite granted.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: "invitee2@example.com",
    });

    // Quoted-printable wraps long lines with a trailing `=`, so the code can be
    // split across a soft break — grepping the raw body would fail against a
    // message that is perfectly correct. Undo the wrapping first.
    const body = fixture.messages[0].data.replace(/=\r?\n/g, "");
    expect(body).toContain(response.body.invite.code);
  });

  test("no address still means a copy-link invite, unchanged", async () => {
    // The pre-S11 path. Nothing is sent, nothing expires.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, { workspaceIds: [] });

    expect(response.status).toBe(200);
    expect(fixture.messages).toHaveLength(0);
    const stored = await prisma.invites.findUnique({
      where: { id: response.body.invite.id },
    });
    expect(stored.email).toBeNull();
    expect(stored.expiresAt).toBeNull();
  });
});

describe("issue 80 (ruling D): mailing needs more than minting", () => {
  test("a caller without user.manage cannot mail an invite", async () => {
    // `manager` holds invite.create but not user.manage. Minting a link they
    // hand over themselves is one thing; sending mail from the deployment's
    // domain to an address of their choosing is another.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(managerAuth, {
      email: "refused-by-permission@example.com",
    });

    expect(response.status).toBe(403);
    // Refused means nothing was sent AND nothing was created — a half-done
    // invite the caller cannot see is worse than a clean refusal.
    expect(fixture.messages).toHaveLength(0);
    // Scoped to THIS address: earlier tests in this file mail invites of their
    // own, so a table-wide count would fail for reasons unrelated to the refusal.
    expect(
      await prisma.invites.count({
        where: { email: "refused-by-permission@example.com" },
      })
    ).toBe(0);
  });

  test("the same caller can still create a copy-link invite", async () => {
    // The permission narrows one capability; it does not take away the one they
    // already had.
    const response = await newInvite(managerAuth, { workspaceIds: [] });
    expect(response.status).toBe(200);
  });
});

describe("issue 80 (ruling D): the request shape is constrained", () => {
  test("more than one address in a request is refused", async () => {
    // One address per request. A list turns an invite endpoint into a bulk
    // mailer, which is the shape abuse takes.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: ["a@example.com", "b@example.com"],
    });

    expect(response.status).toBe(400);
    expect(fixture.messages).toHaveLength(0);
  });

  test("a malformed address is refused before anything is created", async () => {
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const before = await prisma.invites.count();
    const response = await newInvite(adminAuth, { email: "not-an-address" });

    expect(response.status).toBe(400);
    expect(await prisma.invites.count()).toBe(before);
  });

  test("an address with the channel OFF is a 4xx, never a silent success", async () => {
    // The failure ruling D exists to prevent: an admin types an address, gets a
    // 200, and assumes the person was invited. Nothing was sent and nobody is
    // coming.
    await disableMailer();

    const response = await newInvite(adminAuth, {
      email: "channel-off@example.com",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(
      await prisma.invites.count({ where: { email: "channel-off@example.com" } })
    ).toBe(0);
  });

  test("an UNVERIFIED configuration will not send", async () => {
    // Settings exist but no successful test is bound to them. Sending anyway
    // would be the wizard's gate defeated by going around the page.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);
    const mailerSettings = require("../../../utils/notifications/mailerSettings");
    await prisma.system_settings.deleteMany({
      where: { label: mailerSettings.VERIFIED_HASH_KEY },
    });

    const response = await newInvite(adminAuth, {
      email: "invitee@example.com",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fixture.messages).toHaveLength(0);
  });
});

describe("issue 80: the invite code never reaches a log", () => {
  test("mailing an invite writes no code to event_logs", async () => {
    // #71's rule, at a new call site. The mailed link contains the code, so this
    // route is exactly where one would leak back in.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: "invitee3@example.com",
    });
    const code = response.body.invite.code;

    const rows = await prisma.event_logs.findMany({ take: 200 });
    for (const row of rows) expect(JSON.stringify(row)).not.toContain(code);
  });

  test("the recipient address is not written to event_logs either", async () => {
    // Ruling C's half that belongs here: an address is personal data, and the
    // audit allowlist must not grow an `email` key to accommodate this route.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    await newInvite(adminAuth, { email: "private.person@example.com" });

    const rows = await prisma.event_logs.findMany({ take: 200 });
    for (const row of rows)
      expect(JSON.stringify(row)).not.toContain("private.person@example.com");
  });
});
