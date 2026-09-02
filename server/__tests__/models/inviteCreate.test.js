// S11a (#80), QA-1 NIT-1 — `Invite.create`'s pairing rule, at the model.
//
// The rule: supplying an address implies an expiry. It is enforced in the model
// rather than at the routes because two routes create invites
// (`endpoints/admin.js`, `endpoints/api/admin/index.js`) and both come through
// this function — it is the only place that sees every creation.
//
// It shipped with no test of its own. QA-1 measured that: mutating
// `if (normalizedEmail && !expiry)` to `if (false)` left the whole suite green,
// so the guard was decoration. These are the tests that kill that mutant, and
// they exist BEFORE the route is allowed to pass an address through.

const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");

const SERVER_DIR = path.resolve(__dirname, "../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const suffix = crypto.randomBytes(4).toString("hex");
const testSchemaName = `s11a_invite_${suffix}`;

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql:"))
  throw new Error("DATABASE_URL must point at PostgreSQL for this suite");
const testUrl = new URL(baseDatabaseUrl);
testUrl.searchParams.set("schema", testSchemaName);
process.env.DATABASE_URL = testUrl.toString();

let prisma;
let Invite;

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", SCHEMA], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: "pipe",
  });
  prisma = new PrismaClient({
    datasources: { db: { url: testUrl.toString() } },
  });
  ({ Invite } = require("../../models/invite"));
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`
  );
  await admin.$disconnect();
});

describe("issue 80: an emailed invite must expire", () => {
  test("an address with an explicit null expiry is REFUSED", async () => {
    // The mutant's target. A link mailed to an inbox and valid forever is a
    // bearer credential in someone's mail history — and unlike a copy-link
    // invite, nobody can say where it ended up or who forwarded it.
    const before = await prisma.invites.count();
    const { invite, error } = await Invite.create({
      createdByUserId: 0,
      email: "invitee@example.com",
      expiresAt: null,
    });

    expect(invite).toBeNull();
    expect(error).toMatch(/expiry/i);
    // Refused means nothing was written, not written-then-rejected.
    expect(await prisma.invites.count()).toBe(before);
  });

  test("an address with no expiry argument gets the default, not nothing", async () => {
    // The ordinary path: an admin types an address and does not choose a
    // duration. Omitting the argument must not be read as "no expiry".
    const { invite, error } = await Invite.create({
      createdByUserId: 0,
      email: "invitee2@example.com",
    });

    expect(error).toBeNull();
    expect(invite.expiresAt).not.toBeNull();
    expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("an explicit expiry is honoured over the default", async () => {
    // An admin choosing 24 hours must get 24 hours, not seven days.
    const chosen = new Date(Date.now() + HOUR);
    const { invite, error } = await Invite.create({
      createdByUserId: 0,
      email: "invitee3@example.com",
      expiresAt: chosen,
    });

    expect(error).toBeNull();
    expect(invite.expiresAt.getTime()).toBe(chosen.getTime());
  });

  test("a copy-link invite still has NO expiry and NO address", async () => {
    // The pre-S11 behaviour, unchanged. Guard the guard: without this, code that
    // gave everything an expiry would pass every test above.
    const { invite, error } = await Invite.create({ createdByUserId: 0 });

    expect(error).toBeNull();
    expect(invite.email).toBeNull();
    expect(invite.expiresAt).toBeNull();
  });

  test("a blank or whitespace address is treated as no address", async () => {
    // A form that posts an empty field must produce a copy-link invite, not an
    // invite addressed to "" — which would satisfy a truthiness check on some
    // other path later.
    for (const email of ["", "   ", null]) {
      const { invite, error } = await Invite.create({
        createdByUserId: 0,
        email,
      });
      expect(error).toBeNull();
      expect(invite.email).toBeNull();
      expect(invite.expiresAt).toBeNull();
    }
  });
});
