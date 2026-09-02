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

let adminAuth;
let adminId;
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
    data: {
      username,
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });
  const role = await prisma.roles.create({
    data: { name: `minter-${process.pid}`, scope: "org" },
  });
  // `invite.read` as well, so this fixture can also exercise the LISTING: the
  // point of the role is "may work with invites, may not manage users", and a
  // caller who cannot read the list cannot demonstrate that addresses are
  // masked for them.
  const permissions = await prisma.permissions.findMany({
    where: { action: { in: ["invite.create", "invite.read"] } },
  });
  for (const permission of permissions)
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
  adminId = (
    await prisma.users.findFirst({ where: { username: "mail-admin" } })
  ).id;
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
      await prisma.invites.count({
        where: { email: "channel-off@example.com" },
      })
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

describe("issue 80 (QA-2): the mail limiter is MOUNTED on the real route", () => {
  // The finding this replaces: two limiters were defined, exported, and mounted
  // nowhere, while a test drove a synthetic app built in the test file. It was
  // green and guarded nothing — removing the limiters entirely broke no test.
  // These go through `/api/admin/invite/new` itself.
  test("mailed invites are refused past the ceiling", async () => {
    process.env.INVITE_MAIL_RATE_LIMIT_MAX = "10";
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await newInvite(adminAuth, {
        email: `limited-${attempt}@example.com`,
      });
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 429)).not.toHaveLength(0);
    expect(statuses[10]).toBe(429);
    delete process.env.INVITE_MAIL_RATE_LIMIT_MAX;
  }, 60_000);

  test("copy-link invites are NOT metered by it", async () => {
    // A copy-link invite costs a database row and touches no relay. Throttling
    // it would slow ordinary admin work to protect a resource it never uses.
    process.env.INVITE_MAIL_RATE_LIMIT_MAX = "2";
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++)
      statuses.push((await newInvite(adminAuth, { workspaceIds: [] })).status);

    expect(statuses.every((status) => status === 200)).toBe(true);
    delete process.env.INVITE_MAIL_RATE_LIMIT_MAX;
  }, 60_000);

  test("two callers do not share a bucket", async () => {
    // Per-actor, not global: one admin exhausting their budget must not lock
    // every other admin out of inviting anybody.
    process.env.INVITE_MAIL_RATE_LIMIT_MAX = "2";
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    for (let attempt = 0; attempt < 3; attempt++)
      await newInvite(adminAuth, { email: `first-${attempt}@example.com` });

    // A different admin, with user.manage, still gets served.
    const other = await makeUser("mail-admin-two", "admin");
    const response = await newInvite(other, { email: "second@example.com" });

    expect(response.status).not.toBe(429);
    delete process.env.INVITE_MAIL_RATE_LIMIT_MAX;
  }, 60_000);
});

describe("issue 80 (TL-1): addresses are masked in the listings", () => {
  // This SHA created the exposure: `invites.email` was always null before, so
  // returning whole rows was harmless. Populating it turned `GET /admin/invites`
  // into a roster of everyone invited, readable by anyone holding `invite.read`
  // — a much wider grant than "may see who we contacted".
  test("a caller without user.manage sees a masked address", async () => {
    fixture = await startSmtpFixture();
    await configureMailer(fixture);
    await newInvite(adminAuth, { email: "listed.person@example.com" });

    const listed = await request(app)
      .get("/api/admin/invites")
      .set("Authorization", managerAuth);

    expect(listed.status).toBe(200);
    const body = JSON.stringify(listed.body);
    expect(body).not.toContain("listed.person@example.com");
    // Masked, not removed: an admin still has to tell one invite from another.
    expect(body).toContain("l***@example.com");
  });

  test("a caller WITH user.manage sees the address", async () => {
    // Guard the guard: masking everyone would pass the test above while making
    // the feature useless to the person who sent the invitation.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);
    await newInvite(adminAuth, { email: "visible.person@example.com" });

    const listed = await request(app)
      .get("/api/admin/invites")
      .set("Authorization", adminAuth);

    expect(JSON.stringify(listed.body)).toContain("visible.person@example.com");
  });

  test("the /v1 listing never shows a full address", async () => {
    // An API key cannot hold `user.manage` — the scope vocabulary has no such
    // scope — so masked is the only honest answer there.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);
    await newInvite(adminAuth, { email: "api.listed@example.com" });

    const { ApiKey } = require("../../../models/apiKeys");
    const { apiKey } = await ApiKey.create(adminId, "listing-key", {
      scopes: ["invite.read"],
    });
    const listed = await request(app)
      .get("/api/v1/admin/invites")
      .set("Authorization", `Bearer ${apiKey.secret}`);

    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("api.listed@example.com");
  }, 30_000);
});

describe("issue 80 (TL-1/TL-2 gaps): the response says what happened", () => {
  test("GAP-2: /v1 refuses an address rather than ignoring it", async () => {
    const { ApiKey } = require("../../../models/apiKeys");
    const { apiKey } = await ApiKey.create(adminId, "v1-invite-key", {
      scopes: ["invite.create"],
    });

    const response = await request(app)
      .post("/api/v1/admin/invite/new")
      .set("Authorization", `Bearer ${apiKey.secret}`)
      .send({ email: "someone@example.com" });

    expect(response.status).toBe(400);
    expect(response.body.invite).toBeNull();
  }, 30_000);

  test("a mailed invite reports mailed: true", async () => {
    // A FIELD, not a message: the UI branches on a boolean rather than parsing
    // prose that will be translated and reworded.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: "reported@example.com",
    });
    expect(response.body.mailed).toBe(true);
  });

  test("a copy-link invite reports mailed: false", async () => {
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, { workspaceIds: [] });
    expect(response.body.mailed).toBe(false);
  });

  test("GAP-3: a send failure reports mailed:false WITH an error", async () => {
    // The partial-failure shape, through the real route: the invite exists, so
    // the admin is not stranded, but silence here means waiting for someone who
    // was never contacted.
    fixture = await startSmtpFixture({ fail: "permanent" });
    await configureMailer(fixture);

    const response = await newInvite(adminAuth, {
      email: "rejected-by-relay@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.body.invite).not.toBeNull();
    expect(response.body.mailed).toBe(false);
    expect(response.body.error).not.toBeNull();
  });

  test("GAP-3: two invites to different addresses each send", async () => {
    // The notificationId is assembled in `inviteMailer` from the invite and the
    // recipient. If it were derived from either alone, the second person would
    // be silently deduplicated away — and nothing else in the suite runs that
    // assembly through the route.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    await newInvite(adminAuth, { email: "fanout-one@example.com" });
    await newInvite(adminAuth, { email: "fanout-two@example.com" });

    expect(fixture.messages).toHaveLength(2);
    const recipients = fixture.messages.map((m) => m.to.join(" ")).join(" ");
    expect(recipients).toContain("fanout-one@example.com");
    expect(recipients).toContain("fanout-two@example.com");
  });
});

describe("issue 80 (QA-3): the ceiling holds under a flood on the real route", () => {
  // QA-3 measured 15 requests all returning 200 against a ceiling of 10. That is
  // the shape this suite must be able to catch, so these use the BUILT-IN
  // default rather than setting the env — a test that configures its own ceiling
  // proves the limiter reads config, not that the shipped default protects
  // anything.
  test("the eleventh mailed invite is refused, and creates nothing", async () => {
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    const statuses = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const response = await newInvite(adminAuth, {
        email: `flood-${attempt}@example.com`,
      });
      statuses.push(response.status);
    }

    // Ten through, then refusals — the default ceiling is 10.
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    // A refusal costs nothing downstream: no invite row, and no RCPT at the
    // relay. A limiter that answered 429 after sending would be worse than none,
    // because the operator would believe nothing went out.
    const refused = await prisma.invites.count({
      where: { email: "flood-10@example.com" },
    });
    expect(refused).toBe(0);
    expect(fixture.messages).toHaveLength(10);
  }, 120_000);

  test("a second actor is unaffected by the first's exhausted budget", async () => {
    // Per-actor, not global: one admin hitting their ceiling must not stop the
    // rest of the organisation from inviting anyone.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);

    for (let attempt = 0; attempt < 12; attempt++)
      await newInvite(adminAuth, { email: `exhaust-${attempt}@example.com` });

    const other = await makeUser("mail-admin-three", "admin");
    const response = await newInvite(other, {
      email: "unaffected@example.com",
    });

    expect(response.status).not.toBe(429);
  }, 120_000);
});

describe("issue 80 (QA-3): the mask is identical everywhere and leaks no length", () => {
  test("both listings mask the same address the same way", async () => {
    // Byte-identical, because two spellings of "masked" is how one of them
    // quietly stops masking: a reviewer comparing the outputs would see a
    // difference and have to decide which is correct.
    fixture = await startSmtpFixture();
    await configureMailer(fixture);
    await newInvite(adminAuth, { email: "identical.mask@example.com" });

    const { ApiKey } = require("../../../models/apiKeys");
    const { apiKey } = await ApiKey.create(adminId, "mask-compare-key", {
      scopes: ["invite.read"],
    });

    const ui = await request(app)
      .get("/api/admin/invites")
      .set("Authorization", managerAuth);
    const api = await request(app)
      .get("/api/v1/admin/invites")
      .set("Authorization", `Bearer ${apiKey.secret}`);

    const masked = (body) =>
      (body.invites || [])
        .map((invite) => invite.email)
        .filter(Boolean)
        .sort();

    expect(masked(ui.body)).toEqual(masked(api.body));
    expect(masked(ui.body)).toContain("i***@example.com");
  }, 30_000);

  test("the mask does not reveal how long the local part was", async () => {
    // A variable-width mask turns into a length oracle: `ab***@` versus
    // `abcdefgh***@` narrows a guess considerably, and addresses at one company
    // follow a house pattern.
    const { Invite } = require("../../../models/invite");
    const short = Invite.maskEmail("a@example.com");
    const long = Invite.maskEmail("averylongaddressindeed@example.com");

    // Same length, and identical: the mask is fixed-width by construction, so
    // nothing about the original survives except its first character and domain.
    expect(short).toBe(long);
    expect(short).toBe("a***@example.com");
  });
});

describe("issue 80 (QA-2): what actually keeps an invite code out of the audit log", () => {
  // The protection is NOT the allowlist. `inviteId` is allowlisted and accepts
  // any value, so if a call site ever put a code there — or the id became a
  // UUID-shaped string — the key check would wave it through. What stops it is
  // the VALUE scrubber matching the `apw-inv-` shape.
  //
  // Both halves are pinned here because each is useless alone: the scrubber only
  // helps while codes keep that prefix, and the prefix only matters while the
  // scrubber looks for it.
  test("a code placed under the allowlisted inviteId key is still scrubbed", async () => {
    const {
      redactEventData,
    } = require("../../../utils/events/redaction");
    const { Invite } = require("../../../models/invite");

    const code = Invite.makeCode();
    const { data } = redactEventData({ inviteId: code });

    expect(JSON.stringify(data)).not.toContain(code);
    expect(JSON.stringify(data)).toContain("[redacted:credential]");
  });

  test("invite codes still carry the prefix the scrubber matches", async () => {
    // If the generator changed to `inv_` or a bare UUID, the scrubber would stop
    // recognising codes and every assertion about audit safety would quietly
    // become vacuous — passing, while protecting nothing.
    const { Invite } = require("../../../models/invite");
    expect(Invite.makeCode()).toMatch(/^apw-inv-[A-Za-z0-9_-]{16,}$/);
  });
});
