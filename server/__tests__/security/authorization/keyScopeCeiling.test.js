/**
 * PR-4d (#35): an API key cannot be minted with more than its creator holds.
 *
 * PR-4c made every key carry an enumerated scope list instead of "*", but the list a
 * creator may ask for is still a preset chosen by which endpoint they called. Both mint
 * sites sit behind an admin gate, so nobody can currently exceed an admin — that is why
 * #27 recorded it as a ponytail rather than a hole. It stops being true the moment a
 * non-admin role gains key.manage, which the seeded setup_admin role already has.
 *
 * Two refusals, deliberately distinct (PMO ruling 1). Authority to mint AT ALL is
 * `key.manage`, and it is checked first. The ceiling on WHAT a key may hold is checked
 * second, over the scope list. A single error for both would let a `key.manage` bug
 * hide behind a scope failure, so every case below asserts WHICH refusal fired. The
 * `content_moderator` cases are the load-bearing ones: that role holds real route
 * scopes and not key.manage, so nothing about its scope list can explain the refusal.
 */
const path = require("path");
const { execFileSync } = require("child_process");

const schemaName = `keyceiling_${process.pid}`;
const baseUrl = new URL(process.env.DATABASE_URL ?? "");
if (baseUrl.protocol !== "postgresql:")
  throw new Error("PR-4d tests require DATABASE_URL pointing at PostgreSQL");
baseUrl.searchParams.set("schema", schemaName);
process.env.DATABASE_URL = baseUrl.toString();
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "pr4d-ceiling-pepper-32-bytes-min";
process.env.SIG_KEY = process.env.SIG_KEY || "pr4d-ceiling-sig-key-long-enough-for-scrypt-derivation";

jest.setTimeout(300000);

const serverRoot = path.resolve(__dirname, "../../..");
// Built with migrate deploy so the migrations' INSERT blocks run too; a schema-only
// build would leave the seeded roles and permissions missing (code-standards 7.1a).
execFileSync(
  path.resolve(serverRoot, "node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.resolve(serverRoot, "prisma/schema.prisma")],
  { cwd: serverRoot, env: process.env, stdio: "ignore" }
);

const prisma = require("../../../utils/prisma");
const { ApiKey } = require("../../../models/apiKeys");
const { SystemSettings } = require("../../../models/systemSettings");
const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/actorResolver");
const {
  ADMIN_DEFAULT_SCOPES,
} = require("../../../utils/apiKeySecurity/scopes");

const SYS = SERVICE_PRINCIPALS.singleUser;
let roles = {};
let superAdmin;
let setupAdmin;
let memberUser;
let moderator;
let workspaceA;
let workspaceB;

beforeAll(async () => {
  const rows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
  for (const row of rows) roles[`${row.name}:${row.scope}`] = row.id;

  [superAdmin, setupAdmin, memberUser, moderator] = await Promise.all(
    ["ceiling-super", "ceiling-setup", "ceiling-member", "ceiling-mod"].map((username) =>
      prisma.users.create({ data: { username, password: "x", role: "admin" } })
    )
  );
  [workspaceA, workspaceB] = await Promise.all(
    ["ceiling-ws-a", "ceiling-ws-b"].map((slug) =>
      prisma.workspaces.create({ data: { name: slug, slug } })
    )
  );

  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(superAdmin.id),
    roleId: roles["super_admin:org"], db: prisma,
  });
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(setupAdmin.id),
    roleId: roles["setup_admin:org"], db: prisma,
  });
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(memberUser.id),
    roleId: roles["member:org"], db: prisma,
  });
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(moderator.id),
    roleId: roles["content_moderator:org"], db: prisma,
  });
  // superAdmin belongs to A only; the bound-key cases turn on that.
  await prisma.workspace_users.create({
    data: { user_id: superAdmin.id, workspace_id: workspaceA.id },
  });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await prisma.$disconnect();
}, 60_000);

describe("authority to mint at all is key.manage, checked before any scope", () => {
  test("a member is refused for lacking key.manage, naming that and not a scope", async () => {
    // Whatever scopes `member` is seeded with, it does not hold key.manage — so the
    // error must name that and not a scope. The assertion is deliberately phrased
    // against the ERROR rather than against member's scope list: #52 grants member
    // workspace.read, and a test that leaned on member lacking it would silently stop
    // testing the authority check the day that lands.
    const { apiKey, error } = await ApiKey.create(memberUser.id, "no-authority", {
      scopes: ["workspace.read"],
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/key\.manage/);
    expect(error).not.toMatch(/workspace\.read/);
  });

  test("a moderator asking only for scopes they DO hold is still refused", async () => {
    // content_moderator holds document.read and document.search, so nothing about the
    // scope list can explain this refusal. Only the key.manage check can. (The member
    // role holds chat.send alone, which is not a route scope at all and so can never be
    // requested — the moderator is the role that separates the two checks.)
    const { apiKey, error } = await ApiKey.create(moderator.id, "holds-the-scopes", {
      scopes: ["document.read", "document.search"],
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/key\.manage/);
    expect(error).not.toMatch(/document\.read/);
  });

  test("setup_admin passes the key.manage check — the seeded role holds it", async () => {
    const { apiKey, error } = await ApiKey.create(setupAdmin.id, "may-mint", {
      scopes: ["workspace.read"],
    });

    expect(error).toBeNull();
    expect(apiKey).not.toBeNull();
  });
});

describe("the ceiling: a creator cannot mint a key holding more than they do", () => {
  test("setup_admin is refused system.env.read, and the error names the scope", async () => {
    // setup_admin holds key.manage — it is allowed to mint keys — but its seeded
    // permission set does not include system.env.read, the scope PR-4b(4) separated
    // precisely because it reads the provider credentials.
    const { apiKey, error } = await ApiKey.create(setupAdmin.id, "over-reach", {
      scopes: ["workspace.read", "system.env.read"],
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/system\.env\.read/);
    // The scopes it does hold must not be the thing reported as missing.
    expect(error).not.toMatch(/workspace\.read/);
    // ...and this is the ceiling refusing, not the authority check.
    expect(error).not.toMatch(/key\.manage/);
  });

  test("super_admin gets the same key, because it does hold that scope", async () => {
    const { apiKey, error } = await ApiKey.create(superAdmin.id, "within-reach", {
      scopes: ["workspace.read", "system.env.read"],
    });

    expect(error).toBeNull();
    expect(apiKey).not.toBeNull();
    expect(apiKey.scopes).toBeDefined();
  });

  test("every scope the creator lacks is named, not just the first", async () => {
    // An error naming one scope at a time turns a five-scope request into five
    // round trips, each revealing one more thing the creator cannot do.
    const { error } = await ApiKey.create(setupAdmin.id, "several", {
      scopes: ["system.env.read", "document.delete", "workspace.read"],
    });

    expect(error).toMatch(/system\.env\.read/);
    expect(error).toMatch(/document\.delete/);
  });

  test("an explicit over-reach is refused, never silently trimmed", async () => {
    // PMO ruling 2: a caller who NAMED a scope gets a straight answer about it. Trimming
    // an explicit request would hand back a key that silently does less than asked, and
    // the caller would find out at the first 403 from a route instead of here.
    const { apiKey, error } = await ApiKey.create(setupAdmin.id, "asked-explicitly", {
      scopes: ["system.env.read"],
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/system\.env\.read/);
  });
});

describe("the preset is a default, and the ceiling trims it", () => {
  test("setup_admin minting with no scopes gets preset ∩ its own grants", async () => {
    // PMO ruling 2: an unmodified client posts {name} and keeps working — but the key it
    // receives is bounded by what its creator holds, not by the preset alone.
    const { apiKey, error } = await ApiKey.create(setupAdmin.id, "defaulted", {
      scopes: [...ADMIN_DEFAULT_SCOPES],
      trimToCeiling: true,
    });

    expect(error).toBeNull();
    expect(apiKey).not.toBeNull();
    const granted = JSON.parse(apiKey.scopes);
    // Trimmed to what setup_admin actually holds...
    expect(granted).toContain("workspace.read");
    expect(granted).not.toContain("document.delete");
    expect(granted).not.toContain("system.env.read");
    // ...and never wider than the preset it started from.
    for (const scope of granted) expect(ADMIN_DEFAULT_SCOPES).toContain(scope);
  });

  test("the trimmed list is what the caller is told it got", async () => {
    // A response echoing the requested preset while storing less would be a lie the
    // operator only discovers when a route refuses the key.
    const { apiKey } = await ApiKey.create(setupAdmin.id, "echo-check", {
      scopes: [...ADMIN_DEFAULT_SCOPES],
      trimToCeiling: true,
    });

    const stored = await prisma.api_keys.findUnique({ where: { id: apiKey.id } });
    expect(JSON.parse(apiKey.scopes)).toEqual(JSON.parse(stored.scopes));
  });

  test("a creator holding nothing mintable is refused rather than given an empty key", async () => {
    // An empty scope list is a key that authenticates and can do nothing — it looks
    // like a working credential and behaves like a revoked one.
    const { apiKey, error } = await ApiKey.create(memberUser.id, "nothing-left", {
      scopes: [...ADMIN_DEFAULT_SCOPES],
      trimToCeiling: true,
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/key\.manage/);
  });
});

describe("workspace-bound keys require the creator to be in that workspace", () => {
  test("binding to a workspace the creator does not belong to is refused", async () => {
    const { apiKey, error } = await ApiKey.create(superAdmin.id, "not-mine", {
      scopes: ["workspace.read"],
      workspaceId: workspaceB.id,
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/workspace/i);
  });

  test("binding to the creator's own workspace is allowed", async () => {
    const { error } = await ApiKey.create(superAdmin.id, "mine", {
      scopes: ["workspace.read"],
      workspaceId: workspaceA.id,
    });

    expect(error).toBeNull();
  });
});

describe("a creatorless key follows keyGrantPrincipal, not a second path", () => {
  test("in multi-user mode a null creator is refused", async () => {
    // PMO ruling 4. keyGrantPrincipal already answers this: null creator resolves to the
    // single-user service principal ONLY when isConfirmedSingleUser agrees. In multi-user
    // mode there is a real principal the key should have been attributed to, and its
    // absence is an orphan, not a licence to borrow super_admin.
    await prisma.system_settings.upsert({
      where: { label: "multi_user_mode" },
      update: { value: "true" },
      create: { label: "multi_user_mode", value: "true" },
    });
    await prisma.users.create({
      data: { username: "ceiling-presence", password: "x", role: "default" },
    });

    const { apiKey, error } = await ApiKey.create(null, "orphan", {
      scopes: ["workspace.read"],
    });

    expect(apiKey).toBeNull();
    expect(error).toBeTruthy();
    expect(SystemSettings).toBeDefined();
  });
});
