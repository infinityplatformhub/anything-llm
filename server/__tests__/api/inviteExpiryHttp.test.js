// S11a (#80) — invite expiry, and the redemption path's silence.
//
// RED-first: written before `expiresAt` is enforced.
//
// Three properties, and they are separate on purpose:
//
//   1. An expired invite cannot be redeemed. Enforced inside `Invite.get`, not
//      at the routes — the two routes already carry byte-identical copies of the
//      status check, and a third copy is a third place to forget it.
//   2. A copy-link invite (`expiresAt` null) still works, forever. This is every
//      invite that existed before the migration; breaking it is the most
//      expensive way this change can go wrong, so it is asserted directly rather
//      than implied.
//   3. Every redemption failure looks identical on the wire. Otherwise the
//      endpoint answers "was this code real?" to anyone who asks.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-expiry-"));
const schema = `invite_expiry_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql:")) {
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
}
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.API_KEY_PEPPER = "http-test-api-key-pepper-32-bytes";
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../../prisma/seed.js")],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { Invite } = require("../../models/invite");
const {
  resetRequestControls,
} = require("../../utils/middleware/requestControls");

const HOUR = 60 * 60 * 1000;
let counter = 0;
/** A unique, valid username per call — a collision would fail for the wrong reason. */
const freshUsername = () => `invitee-${process.pid}-${counter++}`;

/** Insert an invite directly, so the row's shape is the thing under test. */
async function seedInvite({ expiresAt = null, status = "pending", email = null } = {}) {
  return prisma.invites.create({
    data: {
      code: Invite.makeCode(),
      status,
      email,
      expiresAt,
      createdBy: 0,
      workspaceIds: JSON.stringify([]),
    },
  });
}

const redeem = (code, username = freshUsername()) =>
  request(app)
    .post(`/api/invite/${code}`)
    .send({ username, password: "Str0ng-Passw0rd!" });

beforeEach(async () => {
  await resetRequestControls();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("issue 80: an expired invite cannot be redeemed", () => {
  test("an invite past its expiry is refused, and creates no user", async () => {
    const invite = await seedInvite({
      expiresAt: new Date(Date.now() - HOUR),
      email: "someone@example.com",
    });
    const before = await prisma.users.count();

    const response = await redeem(invite.code);

    expect(response.body.success).toBe(false);
    expect(await prisma.users.count()).toBe(before);

    // And it was not consumed — refusing is not claiming.
    const after = await prisma.invites.findUnique({ where: { id: invite.id } });
    expect(after.status).toBe("pending");
    expect(after.claimedBy).toBeNull();
  });

  test("GET does not confirm an expired code either", async () => {
    // The read side is the cheaper oracle: no account needed, no password
    // guessed. If it answers differently, the POST's silence buys nothing.
    const expired = await seedInvite({ expiresAt: new Date(Date.now() - HOUR) });
    const missing = await request(app).get("/api/invite/apw-inv-does-not-exist");
    const found = await request(app).get(`/api/invite/${expired.code}`);

    expect(found.status).toBe(missing.status);
    expect(found.body).toEqual(missing.body);
  });

  test("an invite still inside its window works normally", async () => {
    // Guard the guard: without this, code that refused EVERY invite would pass
    // every refusal test above and look correct.
    const invite = await seedInvite({ expiresAt: new Date(Date.now() + HOUR) });
    const response = await redeem(invite.code);

    expect(response.body.success).toBe(true);
    const after = await prisma.invites.findUnique({ where: { id: invite.id } });
    expect(after.status).toBe("claimed");
  });

  test("M3: a copy-link invite with NO expiry still works", async () => {
    // The most expensive way this change can break: reading `expiresAt: null` as
    // "expired" retires every invite that existed before the migration, and the
    // failure looks identical to a code that was never real.
    const invite = await seedInvite({ expiresAt: null });
    const response = await redeem(invite.code);

    expect(response.body.success).toBe(true);
  });

  test("M2: the boundary is not off by one — expiry in the future is still valid", async () => {
    // `>` vs `>=` against `now()`. A second from now is valid; a second ago is
    // not. Both directions, because either comparison passes one of them.
    const soon = await seedInvite({ expiresAt: new Date(Date.now() + 5_000) });
    expect((await redeem(soon.code)).body.success).toBe(true);

    const justPast = await seedInvite({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await redeem(justPast.code)).body.success).toBe(false);
  });
});

describe("issue 80 (O1): every redemption failure looks the same", () => {
  test("missing, expired and claimed are byte-for-byte identical", async () => {
    // The pre-existing oracle QA-1 found: reaching `User.create` at all proves
    // the code was valid and pending, so a username collision answered with a
    // different body distinguishes "real code" from "no such code" — without
    // redeeming anything.
    const expired = await seedInvite({ expiresAt: new Date(Date.now() - HOUR) });
    const claimed = await seedInvite({ status: "claimed" });

    const responses = await Promise.all([
      redeem("apw-inv-no-such-code-at-all-here"),
      redeem(expired.code),
      redeem(claimed.code),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(responses[0].status);
      // The raw text, not the parsed object: key order and whitespace are
      // observable too, and `toEqual` on the parsed body would not see them.
      expect(response.text).toBe(responses[0].text);
    }
  });

  test("a taken username does not reveal that the code was real", async () => {
    // The oracle in its original shape. Same username against a VALID invite and
    // a nonexistent one: if the valid one answers "user already exists" while the
    // other answers "invite not found", the difference is the confirmation.
    const taken = freshUsername();
    const first = await seedInvite();
    expect((await redeem(first.code, taken)).body.success).toBe(true);

    const valid = await seedInvite();
    const collision = await redeem(valid.code, taken);
    const nonexistent = await redeem("apw-inv-definitely-not-a-real-code", taken);

    expect(collision.text).toBe(nonexistent.text);
  });

  test("a malformed username is still reported, and checked BEFORE the code", async () => {
    // The deliberate exception: this is something the user can fix, so silence
    // would be hostile rather than safe. It must be answered without consulting
    // the invite at all — otherwise the fact that it IS answered becomes the
    // oracle, in reverse.
    const nonexistent = await redeem("apw-inv-not-a-real-code-here", "A");
    expect(nonexistent.body.success).toBe(false);
    expect(nonexistent.body.error).toMatch(/username/i);
  });
});

describe("issue 80 (OBS-1): a code can only be claimed once", () => {
  test("two simultaneous redemptions of one code produce exactly one account", async () => {
    // Read-then-write across an await is a TOCTOU window: both requests can see
    // `pending` before either writes. The claim has to be a conditional update
    // that the database arbitrates.
    const invite = await seedInvite();

    const [a, b] = await Promise.all([redeem(invite.code), redeem(invite.code)]);
    const succeeded = [a, b].filter((response) => response.body.success === true);

    expect(succeeded).toHaveLength(1);
    const after = await prisma.invites.findUnique({ where: { id: invite.id } });
    expect(after.status).toBe("claimed");
  });

  test("an expired invite cannot be claimed even by a racing request", async () => {
    // The same guard, one layer down: `markClaimed` must re-check expiry rather
    // than trusting the read that preceded it.
    const invite = await seedInvite({ expiresAt: new Date(Date.now() - HOUR) });
    const user = await prisma.users.create({
      data: { username: freshUsername(), password: "x", role: "default" },
    });

    const { success } = await Invite.markClaimed(invite.id, user);
    expect(success).toBe(false);

    const after = await prisma.invites.findUnique({ where: { id: invite.id } });
    expect(after.status).toBe("pending");
  });
});
