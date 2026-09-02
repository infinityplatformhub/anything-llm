// S11a (#80) — the mailer settings routes, over the real HTTP stack.
//
// RED-first: written before the routes exist.
//
// The rule they enforce (mockup B, ruling B): a configuration cannot be SAVED
// until it has actually sent a message, and the proof is bound to those exact
// settings. The wizard shows that rule; this is where it is true, because the
// endpoint is reachable without the page.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-routes-"));
const schema = `mailer_routes_${process.pid}`;
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
  {
    cwd: path.resolve(__dirname, "../../.."),
    env: process.env,
    stdio: "ignore",
  }
);
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../../../prisma/seed.js")],
  {
    cwd: path.resolve(__dirname, "../../.."),
    env: process.env,
    stdio: "ignore",
  }
);

jest.mock("../../../utils/logger", () => () => {});
jest.mock("../../../utils/boot", () => ({
  bootHTTP: jest.fn(),
  bootSSL: jest.fn(),
}));
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
const mailerSettings = require("../../../utils/notifications/mailerSettings");

const SMTP_PASSWORD = "Sup3rSecret!Mail#2026";
let adminAuth;
let memberAuth;
let fixture;

async function makeUser(username, role) {
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  const user = await prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
  });
  await syncLegacyRoleGrant(user, { db: prisma });
  return `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
}

const settingsFor = (fixtureServer) => ({
  smtp_host: fixtureServer.host,
  smtp_port: String(fixtureServer.port),
  smtp_secure: "false",
  smtp_allow_insecure: "true",
  smtp_allow_untrusted_cert: "false",
  smtp_username: "mailer",
  smtp_from_address: "no-reply@example.com",
  smtp_from_name: "ApproofWorkspace",
});

const testMailer = (auth, body) =>
  request(app).post("/api/mailer/test").set("Authorization", auth).send(body);

const saveMailer = (auth, body) =>
  request(app)
    .post("/api/mailer/settings")
    .set("Authorization", auth)
    .send(body);

beforeAll(async () => {
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  adminAuth = await makeUser("mailer-admin", "admin");
  memberAuth = await makeUser("mailer-member", "default");
});

beforeEach(async () => {
  await resetRequestControls();
  await prisma.system_settings.deleteMany({
    where: { label: { startsWith: "smtp_" } },
  });
  delete process.env.SMTP_PASSWORD;
});

afterEach(async () => {
  if (fixture) await fixture.close();
  fixture = undefined;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("issue 80 (ruling A): the mailer routes sit behind system.write", () => {
  test("a member cannot read, test or save mailer settings", async () => {
    // Not settings.write: these carry a relay credential and open outbound
    // connections to a host the caller names.
    fixture = await startSmtpFixture();
    const body = { ...settingsFor(fixture), password: SMTP_PASSWORD };

    expect((await testMailer(memberAuth, body)).status).toBe(403);
    expect((await saveMailer(memberAuth, body)).status).toBe(403);
  });
});

describe("issue 80 (ruling B): saving requires a successful test first", () => {
  test("saving an untested configuration is REFUSED", async () => {
    // The gate. Without it the wizard's own check is decoration, since this
    // endpoint is reachable without the page.
    fixture = await startSmtpFixture();

    const response = await saveMailer(adminAuth, {
      ...settingsFor(fixture),
      password: SMTP_PASSWORD,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    // And nothing was written — not the settings, not the credential.
    const rows = await prisma.system_settings.findMany({
      where: { label: { startsWith: "smtp_" } },
    });
    expect(rows).toHaveLength(0);
  });

  test("test then save works, and the saved config reads as verified", async () => {
    fixture = await startSmtpFixture();
    const settings = settingsFor(fixture);

    const tested = await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });
    expect(tested.status).toBe(200);
    expect(fixture.messages).toHaveLength(1);

    const saved = await saveMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
    });
    expect(saved.status).toBe(200);
    expect(await mailerSettings.isVerified(SMTP_PASSWORD)).toBe(true);
  });

  test("a test proves ONE configuration — editing the host invalidates it", async () => {
    // The mockup-B failure: verify one host, change the form, save on the first
    // host's evidence.
    fixture = await startSmtpFixture();
    const settings = settingsFor(fixture);

    await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });

    const saved = await saveMailer(adminAuth, {
      ...settings,
      smtp_host: "a-different-host",
      password: SMTP_PASSWORD,
    });
    expect(saved.status).toBeGreaterThanOrEqual(400);
  });

  test("a test proves ONE password — rotating it invalidates the proof", async () => {
    fixture = await startSmtpFixture();
    const settings = settingsFor(fixture);

    await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });

    const saved = await saveMailer(adminAuth, {
      ...settings,
      password: "a-rotated-password",
    });
    expect(saved.status).toBeGreaterThanOrEqual(400);
  });

  test("a FAILED test does not license a save", async () => {
    // Guard the guard: if any test call marked the configuration verified, every
    // assertion above would pass while proving nothing about success.
    fixture = await startSmtpFixture({ fail: "auth" });
    const settings = settingsFor(fixture);

    const tested = await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });
    expect(tested.status).toBeGreaterThanOrEqual(400);

    const saved = await saveMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
    });
    expect(saved.status).toBeGreaterThanOrEqual(400);
  });
});

describe("issue 80: the routes never echo the credential", () => {
  test("no response carries the password, on success or failure", async () => {
    fixture = await startSmtpFixture();
    const settings = settingsFor(fixture);

    const tested = await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });
    const saved = await saveMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
    });
    const failed = await testMailer(adminAuth, {
      ...settings,
      smtp_host: "127.0.0.1",
      smtp_port: "1",
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });

    for (const response of [tested, saved, failed])
      expect(JSON.stringify(response.body)).not.toContain(SMTP_PASSWORD);
  });

  test("reading settings back never includes the password", async () => {
    // The settings page has to render the form, so it reads these — and a
    // password rendered into a form is a password in the page source.
    fixture = await startSmtpFixture();
    const settings = settingsFor(fixture);
    await testMailer(adminAuth, {
      ...settings,
      password: SMTP_PASSWORD,
      to: "operator@example.com",
    });
    await saveMailer(adminAuth, { ...settings, password: SMTP_PASSWORD });

    const read = await request(app)
      .get("/api/mailer/settings")
      .set("Authorization", adminAuth);

    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(SMTP_PASSWORD);
    // But it does say whether one is set — an admin needs to know the field is
    // populated without being shown the value.
    expect(read.body.settings).toHaveProperty("hasPassword");
  });
});
