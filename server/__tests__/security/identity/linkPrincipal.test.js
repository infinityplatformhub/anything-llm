// S1 (#36) T6 — linkPrincipal, the CORE half of the seam, against real Postgres.
//
// This is where an ExternalPrincipal becomes a local user: domain policy, role
// assignment and linking all happen here and nowhere else, so S2 (SAML) and S3
// (LDAP) inherit one policy instead of three. Recon §4 cases 5 and 6 live here.
//
// The driver is not involved: these tests hand linkPrincipal a principal
// directly, which is the point — if this file needed a driver, the boundary
// would already be wrong.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s1_link_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let linkPrincipal;
const { RESERVED_APEX } = require("../../../__testHelpers__/identity/urls");
const { deriveUsername } = require("../../../utils/identity/deriveUsername");
const {
  IdentityConflictError,
  IdentityAuthenticationError,
} = require("../../../utils/identityProviders/errors");

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S1 integration tests require DATABASE_URL pointing at PostgreSQL");
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  // The seed carries the T-1 role rows that syncLegacyRoleGrant needs; without
  // it a "linked" user would hold no grant and the engine would deny them.
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  ({ linkPrincipal } = require("../../../utils/identity/linkPrincipal"));
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const principal = (overrides = {}) => ({
  provider: "oidc",
  subject: `sub-${crypto.randomBytes(4).toString("hex")}`,
  email: `user-${crypto.randomBytes(4).toString("hex")}@example.com`,
  emailVerified: true,
  displayName: "A Person",
  groups: [],
  claims: {},
  ...overrides,
});

describe("first login", () => {
  test("creates a local user, links it, and returns it", async () => {
    const external = principal();
    const { user, created } = await linkPrincipal(external, { db: prisma });

    expect(created).toBe(true);
    expect(user.id).toEqual(expect.any(Number));
    const link = await prisma.identity_links.findUnique({
      where: { provider_subject: { provider: "oidc", subject: external.subject } },
    });
    expect(link.userId).toBe(user.id);
    expect(link.email).toBe(external.email);
  });

  test("R2: a first-time SSO user gets the member role and a matching grant", async () => {
    const { user } = await linkPrincipal(principal(), { db: prisma });
    expect(user.role).toBe("default");

    // A user with no grant is denied by the authorization engine (T-4a). A
    // "successful" login that lands on a user who cannot do anything is the
    // bug class this assertion exists for.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      include: { roles: true },
    });
    expect(grants).toHaveLength(1);
    // Specifically `member`, org-scoped — not merely "some grant exists". A
    // login that handed out super_admin would satisfy a laxer assertion.
    expect(grants[0].roles.name).toBe("member");
    expect(grants[0].roles.scope).toBe("org");
    expect(grants[0].workspace_id).toBeNull();
  });

  test("no password is usable — an SSO account cannot be logged into locally", async () => {
    const { user } = await linkPrincipal(principal(), { db: prisma });
    const row = await prisma.users.findUnique({ where: { id: user.id } });
    // Whatever fills the column, it must not be a hash of anything guessable,
    // and it must never be empty: an empty/short hash is a login with no
    // password at all.
    expect(typeof row.password).toBe("string");
    expect(row.password.length).toBeGreaterThan(20);
  });

  test("an unverified principal is refused before any row is written", async () => {
    const before = await prisma.users.count();
    await expect(
      linkPrincipal(principal({ emailVerified: false }), { db: prisma })
    ).rejects.toThrow(IdentityAuthenticationError);
    expect(await prisma.users.count()).toBe(before);
  });
});

describe("returning login (recon §4 case 6: subject stability)", () => {
  test("the same subject resolves to the SAME user, even when the email changed", async () => {
    const external = principal();
    const { user: first } = await linkPrincipal(external, { db: prisma });

    const renamed = { ...external, email: `new-${external.email}` };
    const { user: second, created } = await linkPrincipal(renamed, { db: prisma });

    // Identity is provider+subject. Someone changing their address at the IdP
    // must keep their account, not get a new one.
    expect(second.id).toBe(first.id);
    expect(created).toBe(false);
    const link = await prisma.identity_links.findUnique({
      where: { provider_subject: { provider: "oidc", subject: external.subject } },
    });
    expect(link.email).toBe(renamed.email);
    expect(link.lastLoginAt).toBeInstanceOf(Date);
  });

  test("a DIFFERENT subject with the same email is NOT a silent takeover", async () => {
    const first = principal();
    await linkPrincipal(first, { db: prisma });

    // Same address, new external identity: this is the takeover shape, and R1
    // says refuse rather than link.
    const impostor = principal({ email: first.email });
    await expect(linkPrincipal(impostor, { db: prisma })).rejects.toThrow(
      IdentityConflictError
    );
  });
});

describe("R1 — email collision with an existing local account", () => {
  test("refuses to auto-link, and says where to link deliberately", async () => {
    const username = `local-${crypto.randomBytes(4).toString("hex")}`;
    const email = `${username}@example.com`;
    await prisma.users.create({
      data: { username: email, password: "local-hash", role: "default" },
    });

    const error = await linkPrincipal(principal({ email }), { db: prisma }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityConflictError);
    expect(error.retryable).toBe(false);
    // The user has to be told what to do next; "conflict" alone leaves them
    // stuck with no path forward.
    expect(error.message).toMatch(/settings/i);
  });

  test("QA-2.6: the collision check is case-insensitive in BOTH directions", async () => {
    // Email addresses are not case-sensitive in practice, so a case-sensitive
    // check is an auto-link waiting to happen — and the whole point of R1 is
    // that owning the mailbox must not be enough to inherit the account.
    //
    // The stored username carries the uppercase here, and the incoming
    // assertion is lowercase. That ordering matters: linkPrincipal lowercases
    // the INCOMING address, so a test that also stored a lowercase username
    // would pass against a plain equality check and prove nothing.
    const local = `Collide-${crypto.randomBytes(4).toString("hex")}`;
    await prisma.users.create({
      data: {
        username: `${local.toUpperCase()}@${RESERVED_APEX.toUpperCase()}`,
        password: "local-hash",
        role: "default",
      },
    });
    await expect(
      linkPrincipal(principal({ email: `${local.toLowerCase()}@${RESERVED_APEX}` }), {
        db: prisma,
      })
    ).rejects.toThrow(IdentityConflictError);
  });

  test("QA-1 NIT-1: a collision on the DERIVED username is R1's 409, not a raw constraint error", async () => {
    // An SSO-created account is stored under its derived username, not the raw
    // address. Checking only the raw address misses that collision, and it then
    // surfaces as a P2002 the caller sees as a bare 401 — against the FIRST
    // person's account, which did nothing wrong. It has to be R1's conflict,
    // which is the answer that tells the user what to do.
    const local = `1derived-${crypto.randomBytes(4).toString("hex")}`;
    const email = `${local}@${RESERVED_APEX}`;
    await prisma.users.create({
      data: {
        username: deriveUsername(email),
        password: "local-hash",
        role: "default",
      },
    });

    const error = await linkPrincipal(principal({ email }), { db: prisma }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityConflictError);
    expect(error.message).toMatch(/settings/i);
  });

  test("QA-1 NIT-1: a derived-username clash yields a suffixed account, not an error", async () => {
    // Two genuinely different mailboxes that sanitize to the same handle. This
    // is NOT the takeover case — R1 checks the email and has already passed —
    // so the second person must get their own account. Before the retry loop,
    // this surfaced as a P2002 the caller saw as a bare 401, and the person who
    // arrived FIRST is the one whose login appeared to break.
    //
    // `+` and `!` are both sanitized to `-`, so these two addresses derive the
    // same username while remaining different mailboxes.
    const suffix = crypto.randomBytes(4).toString("hex");
    const first = await linkPrincipal(
      principal({ email: `user+${suffix}@${RESERVED_APEX}` }),
      { db: prisma }
    );
    const second = await linkPrincipal(
      principal({ email: `user!${suffix}@${RESERVED_APEX}` }),
      { db: prisma }
    );

    // Same derived handle, different people, two accounts.
    expect(deriveUsername(`user+${suffix}@${RESERVED_APEX}`)).toBe(
      deriveUsername(`user!${suffix}@${RESERVED_APEX}`)
    );
    expect(second.user.id).not.toBe(first.user.id);
    expect(second.user.username).not.toBe(first.user.username);
    expect(second.user.username).toMatch(/-sso-[0-9a-f]+$/);
  });

  test("PMO ruling 1: the handle comparison normalizes BOTH sides", async () => {
    // `User+X@` and `user+x@` are one mailbox. If either side of the comparison
    // skips a step of the normalization the other side applies, they stop
    // matching and the collision rule quietly does nothing — which is exactly
    // the failure the rule exists to prevent, only now it looks like it works.
    const suffix = crypto.randomBytes(4).toString("hex");
    const stored = deriveUsername(`user+${suffix}@${RESERVED_APEX}`);
    await prisma.users.create({
      data: { username: stored, password: "local-hash", role: "default" },
    });

    // Arrives with different case in both the local part and the domain.
    const incoming = `User+${suffix.toUpperCase()}@${RESERVED_APEX.toUpperCase()}`;
    const error = await linkPrincipal(principal({ email: incoming }), {
      db: prisma,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(IdentityConflictError);
    expect(error.message).toMatch(/settings/i);
  });

  test("PMO ruling 2: an email already linked to ANOTHER provider stays under R1", async () => {
    // The handle rule must not shadow the email rule. This address is already
    // federated somewhere else, so the account carries identity_links — which
    // is precisely the marker the handle rule uses to say "different person,
    // give them their own account". Checking the handle FIRST would send one
    // mailbox down the suffix retry and create a second account for it.
    const email = `crossidp-${crypto.randomBytes(4).toString("hex")}@${RESERVED_APEX}`;
    await linkPrincipal(principal({ provider: "oidc", email }), { db: prisma });
    const usersBefore = await prisma.users.count();

    // Same address, a different provider and subject.
    const error = await linkPrincipal(
      principal({ provider: "saml", email }),
      { db: prisma }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(IdentityConflictError);
    // R1's email-match refusal, not the handle rule's, and not a second account.
    expect(error.message).toMatch(/already linked to another identity/i);
    expect(await prisma.users.count()).toBe(usersBefore);
  });

  test("the refusal writes nothing — no user, no link", async () => {
    const email = `taken-${crypto.randomBytes(4).toString("hex")}@example.com`;
    await prisma.users.create({
      data: { username: email, password: "local-hash", role: "default" },
    });
    const usersBefore = await prisma.users.count();
    const linksBefore = await prisma.identity_links.count();

    await expect(linkPrincipal(principal({ email }), { db: prisma })).rejects.toThrow(
      IdentityConflictError
    );

    expect(await prisma.users.count()).toBe(usersBefore);
    expect(await prisma.identity_links.count()).toBe(linksBefore);
  });
});

describe("recon §4 case 5 — linking conflict at the database level", () => {
  test("a second user cannot claim an already-linked (provider, subject)", async () => {
    const external = principal();
    const { user: owner } = await linkPrincipal(external, { db: prisma });

    const other = await prisma.users.create({
      data: {
        username: `other-${crypto.randomBytes(4).toString("hex")}`,
        password: "hash",
        role: "default",
      },
    });

    // Asserted against the constraint, not a branch: application logic can be
    // bypassed by the next code path that forgets to call it.
    await expect(
      prisma.identity_links.create({
        data: {
          userId: other.id,
          provider: external.provider,
          subject: external.subject,
          email: external.email,
        },
      })
    ).rejects.toThrow();

    const links = await prisma.identity_links.findMany({
      where: { provider: external.provider, subject: external.subject },
    });
    expect(links).toHaveLength(1);
    expect(links[0].userId).toBe(owner.id);
  });
});

describe("suspended accounts", () => {
  test("a suspended user cannot log back in through SSO", async () => {
    const external = principal();
    const { user } = await linkPrincipal(external, { db: prisma });
    await prisma.users.update({ where: { id: user.id }, data: { suspended: 1 } });

    // Suspension is an admin's decision; an alternative ingress that ignores it
    // would make suspending someone meaningless.
    await expect(linkPrincipal(external, { db: prisma })).rejects.toThrow(
      IdentityAuthenticationError
    );
  });
});
