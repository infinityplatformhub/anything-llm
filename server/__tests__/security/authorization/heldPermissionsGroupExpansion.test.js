/**
 * #128: `heldPermissionIds` must expand the actor's group memberships.
 *
 * Since #96 the ENGINE expands `group_members` when it evaluates grants, and #113
 * made membership itself an authorization path. `heldPermissionIds` never caught up:
 * it reads the actor's OWN `principal_role_grants` rows only. So a delegated admin
 * whose role reaches them through a group is authorized by the engine to act, and
 * then refused by `grantRole`, `canAssignLegacyRole` and `refuseGroupEscalation` —
 * the three places that ask what the actor holds.
 *
 * That is fail-closed, which is why it shipped: nothing is over-permitted, so no
 * alarm fires. It is still wrong, and it is the shape that gets "fixed" under
 * pressure by handing someone a direct grant they should not need — turning a
 * missing expansion into a permanent over-grant nobody revisits.
 *
 * ORDERING (TL-1 pre-read, `techlead-128-preread.md`): this lands AFTER #113's
 * `refuseGroupEscalation`. The two are unsafe apart — expanding groups here while
 * membership writes are unguarded completes a chain: add yourself to a group,
 * inherit its permissions, satisfy the escalation guard, grant yourself directly.
 * #113 merged at `1ac806cfc`; this branches from it.
 */

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `i128_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#128 requires DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/principals");
const {
  DatabaseAuthorizationEngine,
} = require("../../../utils/authorization/engine");
const {
  AuthorizationContractError,
} = require("../../../utils/authorization/errors");
const SYS = SERVICE_PRINCIPALS.singleUser;

let seq = 0;
const uniq = (label) => `i128-${label}-${dbSuffix}-${++seq}`;

/** A user whose ONLY path to `roleName` is membership of a group holding it. */
async function userInRoleGroup(roleName, { workspaceId = null } = {}) {
  const user = await prisma.users.create({
    data: { username: uniq(`u-${roleName}`), password: "x", role: "default" },
  });
  const group = await prisma.groups.create({
    data: {
      orgId: 1,
      name: uniq(`g-${roleName}`),
      source: "lark",
      externalId: uniq(`od-${roleName}`),
    },
  });
  const role = await prisma.roles.findFirstOrThrow({
    where: workspaceId == null ? { name: roleName, scope: "org" } : { name: roleName },
  });
  await repository.grantRole({
    actor: SYS,
    principalType: "group",
    principalId: String(group.id),
    roleId: role.id,
    workspaceId,
    db: prisma,
  });
  // The membership write goes through the repository (and therefore #113's guard),
  // as an exempt principal — this is exactly the S4b reconciler's path.
  await repository.addGroupMember({
    actor: SYS,
    groupId: group.id,
    userId: user.id,
    db: prisma,
  });
  return { user, group, role, actor: { type: "user", id: String(user.id), orgId: 1 } };
}

describe("#128 RF-1: a role held only through a group is a role the actor holds", () => {
  test("a group-held super_admin can assign every legacy role", async () => {
    // The defect in its plainest form. The engine authorizes this user for
    // `role.grant`; `canAssignLegacyRole` refused them, so the admin UI showed a
    // super_admin who could not create an admin.
    const { actor } = await userInRoleGroup("super_admin");

    for (const targetRole of ["admin", "manager", "default"]) {
      await expect(
        repository.canAssignLegacyRole({ actor, targetRole, db: prisma })
      ).resolves.toBe(true);
    }
  }, 120_000);

  test("a group-held super_admin can grant a role directly", async () => {
    // `grantRole`'s escalation guard reads the same helper, so the same user was
    // refused there too. Asserted through the write rather than the helper: the
    // helper being right is only useful if the guard that calls it changes answer.
    const { actor } = await userInRoleGroup("super_admin");
    const target = await prisma.users.create({
      data: { username: uniq("target"), password: "x", role: "default" },
    });
    const targetRole = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    });

    await expect(
      repository.grantRole({
        actor,
        principalType: "user",
        principalId: String(target.id),
        roleId: targetRole.id,
        db: prisma,
      })
    ).resolves.toMatchObject({ id: expect.anything() });
  }, 120_000);

  test("a user holding NOTHING is still refused — expansion is not a free pass", async () => {
    // Without this, "expand groups" is satisfied by a helper that returns every
    // permission to everyone. This is the control that keeps RF-1 meaningful.
    const stranger = await prisma.users.create({
      data: { username: uniq("stranger"), password: "x", role: "default" },
    });
    const actor = { type: "user", id: String(stranger.id), orgId: 1 };

    await expect(
      repository.canAssignLegacyRole({ actor, targetRole: "admin", db: prisma })
    ).resolves.toBe(false);
  }, 120_000);

  test("membership in a group holding NO grants confers nothing", async () => {
    // The other half of the control: being in a group is not itself authority. A
    // helper that widened on membership alone passes the tests above.
    const user = await prisma.users.create({
      data: { username: uniq("empty"), password: "x", role: "default" },
    });
    const group = await prisma.groups.create({
      data: { orgId: 1, name: uniq("g-empty"), source: "lark", externalId: uniq("od-empty") },
    });
    await repository.addGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });

    await expect(
      repository.canAssignLegacyRole({
        actor: { type: "user", id: String(user.id), orgId: 1 },
        targetRole: "admin",
        db: prisma,
      })
    ).resolves.toBe(false);
  }, 120_000);
});

describe("#128 RF-2: the workspace scope clause still applies to group grants", () => {
  test("a group grant scoped to workspace A does not authorize a grant in workspace B", async () => {
    // The clause `heldPermissionIds` already applied to direct grants must survive
    // expansion. Dropping it while adding groups would let a workspace-A admin —
    // who reaches that role through a group — mint roles in workspace B, which is
    // the scope leak the clause exists to prevent (issue #20).
    const wsA = await prisma.workspaces.create({
      data: { name: uniq("wsA"), slug: uniq("wsa") },
    });
    const wsB = await prisma.workspaces.create({
      data: { name: uniq("wsB"), slug: uniq("wsb") },
    });
    const { actor } = await userInRoleGroup("owner", { workspaceId: wsA.id });
    const target = await prisma.users.create({
      data: { username: uniq("wstarget"), password: "x", role: "default" },
    });
    const viewer = await prisma.roles.findFirstOrThrow({
      where: { name: "viewer", scope: "workspace" },
    });

    // Workspace A: allowed, because that is where the group's grant lives.
    await expect(
      repository.grantRole({
        actor, principalType: "user", principalId: String(target.id),
        roleId: viewer.id, workspaceId: wsA.id, db: prisma,
      })
    ).resolves.toMatchObject({ id: expect.anything() });

    // Workspace B: refused. Same actor, same role, different scope.
    await expect(
      repository.grantRole({
        actor, principalType: "user", principalId: String(target.id),
        roleId: viewer.id, workspaceId: wsB.id, db: prisma,
      })
    ).rejects.toThrow(/does not hold/);
  }, 120_000);

  test("a workspace-scoped group grant does not authorize an ORG-WIDE grant", async () => {
    // The stricter half of the same rule: an org-wide target counts org-wide grants
    // only. A workspace owner reaching the role through a group must not mint a role
    // that applies everywhere.
    const ws = await prisma.workspaces.create({
      data: { name: uniq("wsOnly"), slug: uniq("wsonly") },
    });
    const { actor } = await userInRoleGroup("owner", { workspaceId: ws.id });
    const target = await prisma.users.create({
      data: { username: uniq("orgtarget"), password: "x", role: "default" },
    });
    // `viewer` deliberately, and the choice is what makes this test measure SCOPE.
    // Measured on a migrated database, viewer's permissions are a strict SUBSET of
    // owner's — so containment passes, and the ONLY thing that can refuse this write
    // is the clause requiring an org-wide target to be backed by an org-wide grant.
    //
    // An earlier version used `content_moderator`, which owner does NOT contain (it
    // is missing access.diagnose, chat.read_others, document.bulk_export, org.member).
    // That test refused on containment and never reached the scope clause — it stayed
    // green with the clause deleted, which is how the mutant found it.
    const targetRole = await prisma.roles.findFirstOrThrow({
      where: { name: "viewer", scope: "workspace" },
    });

    await expect(
      repository.grantRole({
        actor, principalType: "user", principalId: String(target.id),
        roleId: targetRole.id, workspaceId: null, db: prisma,
      })
    ).rejects.toThrow(/does not hold/);
  }, 120_000);
});

describe("#128 RF-3: an api-key does not inherit its creator's groups", () => {
  test("a key created by a group-held super_admin cannot grant that role", async () => {
    // The engine refuses this expansion explicitly (`engine.js:189-196`) and the
    // reason applies here unchanged: a key's authority is what its creator holds
    // DIRECTLY. Inheriting the creator's departments would widen the key whenever
    // someone edits a group, against grants its scope list was never reviewed for —
    // and the key's holder is not the person the group was chosen for.
    //
    // `grantPrincipalOf` returns the creator, who IS a user, so the type check does
    // not catch this. It has to be refused on purpose, in the same shape as the
    // engine, or the two layers answer differently about who a key is.
    const { user } = await userInRoleGroup("super_admin");
    const keyActor = {
      type: "service",
      id: "api-key:1",
      orgId: 1,
      grantPrincipal: { type: "user", id: String(user.id) },
    };
    const target = await prisma.users.create({
      data: { username: uniq("keytarget"), password: "x", role: "default" },
    });
    const targetRole = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    });

    await expect(
      repository.grantRole({
        actor: keyActor, principalType: "user", principalId: String(target.id),
        roleId: targetRole.id, db: prisma,
      })
    ).rejects.toThrow(/does not hold/);
  }, 120_000);

  test("a key whose creator is GONE holds nothing — it does not throw", async () => {
    // QA-1's residual on `6087af79c`: I added `if (!grantPrincipal) return new Set()`
    // and shipped it with no test, so deleting the guard survived 49/49.
    //
    // A null `grantPrincipal` is not hypothetical — `engine.js:143` documents it as
    // the state of a key whose creator can no longer be resolved, and the engine
    // answers `no_grant_principal` there. Without the guard, `grantPrincipalPairs`
    // receives null, reads `principal.type`, and the caller gets a TypeError instead
    // of a refusal.
    //
    // That distinction is the whole point. A thrown TypeError escapes the
    // authorization decision entirely: `canAssignLegacyRole` never returns false, it
    // rejects, and whether that ends as a 500 or an unhandled rejection is the
    // caller's business rather than a denial. Failing closed means answering "no",
    // not exploding on the way to answering.
    const orphanKey = {
      type: "service",
      id: "api-key:3",
      orgId: 1,
      grantPrincipal: null,
    };

    await expect(
      repository.canAssignLegacyRole({
        actor: orphanKey,
        targetRole: "admin",
        db: prisma,
      })
    ).resolves.toBe(false);

    // And through a write, since that is the path an orphaned key actually takes.
    const target = await prisma.users.create({
      data: { username: uniq("orphantarget"), password: "x", role: "default" },
    });
    const targetRole = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    });
    await expect(
      repository.grantRole({
        actor: orphanKey,
        principalType: "user",
        principalId: String(target.id),
        roleId: targetRole.id,
        db: prisma,
      })
    ).rejects.toThrow(AuthorizationContractError);
  }, 120_000);

  test("a key whose creator holds the role DIRECTLY still works", async () => {
    // The control. Without it, RF-3 is satisfied by refusing every api-key, which
    // would break every scoped key in the product rather than close a hole.
    const creator = await prisma.users.create({
      data: { username: uniq("directcreator"), password: "x", role: "default" },
    });
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(creator.id),
      roleId: superAdmin.id, db: prisma,
    });
    const keyActor = {
      type: "service",
      id: "api-key:2",
      orgId: 1,
      grantPrincipal: { type: "user", id: String(creator.id) },
    };
    const target = await prisma.users.create({
      data: { username: uniq("directtarget"), password: "x", role: "default" },
    });
    const targetRole = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    });

    await expect(
      repository.grantRole({
        actor: keyActor, principalType: "user", principalId: String(target.id),
        roleId: targetRole.id, db: prisma,
      })
    ).resolves.toMatchObject({ id: expect.anything() });
  }, 120_000);
});

describe("#128 RF-4: the engine and heldPermissionIds agree on one fixture", () => {
  test("what the engine allows, the repository lets the same actor delegate", async () => {
    // The property the whole issue is about: two layers answering the same question
    // about the same user. Asserted on ONE fixture rather than two similar ones,
    // because the defect was precisely that they disagreed — a test that builds a
    // separate world for each cannot see it.
    const { actor } = await userInRoleGroup("super_admin");
    const engine = new DatabaseAuthorizationEngine({ db: prisma });

    const decision = await engine.authorize({
      actor,
      action: "role.grant",
      resource: { type: "org", id: "1" },
    });
    expect(decision.allowed).toBe(true);

    // Same actor, same permission, asked of the repository.
    await expect(
      repository.canAssignLegacyRole({ actor, targetRole: "admin", db: prisma })
    ).resolves.toBe(true);
  }, 120_000);
});

describe("#128 (QA-1 NIT-1 from #113): the exemption is by NAME, not by not-being-a-user", () => {
  test("a non-exempt service actor is REFUSED by refuseGroupEscalation", async () => {
    // QA-1 measured this on #113: replacing `isExemptPrincipal(actor)` with
    // `actor?.type !== "user"` survived 43/43 tests. Every exemption test passed an
    // actor that was BOTH named in the set and not a user, so none of them could
    // tell the two rules apart.
    //
    // The difference is the S-9 hole (issue #20): a scoped API key resolves to a
    // service actor too, so "exempt because not a user" hands every key the
    // exemption that belongs to two named migration principals.
    const group = await prisma.groups.create({
      data: { orgId: 1, name: uniq("g-nit1"), source: "lark", externalId: uniq("od-nit1") },
    });
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "group", principalId: String(group.id),
      roleId: superAdmin.id, db: prisma,
    });
    const victim = await prisma.users.create({
      data: { username: uniq("nit1victim"), password: "x", role: "default" },
    });

    await expect(
      repository.addGroupMember({
        actor: { type: "service", id: "api-key:1", orgId: 1 },
        groupId: group.id,
        userId: victim.id,
        db: prisma,
      })
    ).rejects.toThrow(/does not hold/);

    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: victim.id },
    });
    expect(membership).toBeNull();
  }, 120_000);

  test("the two NAMED principals are still exempt", async () => {
    // The control that keeps the test above from being satisfied by refusing every
    // service actor — which would break the S4b reconciler and every migration.
    const group = await prisma.groups.create({
      data: { orgId: 1, name: uniq("g-nit1b"), source: "lark", externalId: uniq("od-nit1b") },
    });
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "group", principalId: String(group.id),
      roleId: superAdmin.id, db: prisma,
    });
    const user = await prisma.users.create({
      data: { username: uniq("nit1ok"), password: "x", role: "default" },
    });

    await expect(
      repository.addGroupMember({
        actor: SERVICE_PRINCIPALS.coreJobs, groupId: group.id, userId: user.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);
});
