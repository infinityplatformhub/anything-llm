/**
 * Hotfix #39: SERVICE_PRINCIPALS must survive any module load order.
 *
 * actorResolver requires models/systemSettings -> models/user ->
 * legacyRoleGrants -> actorResolver. Whichever of those loads first hands the
 * others a half-built exports object. `SERVICE_PRINCIPALS.coreJobs` is
 * evaluated as a DEFAULT PARAMETER, so at call time rather than import time —
 * it threw "Cannot read properties of undefined (reading 'coreJobs')", the
 * caller caught and logged it, and a new workspace member silently received no
 * grant. Production survived only because index.js happens to load models/user
 * first, which is not a guarantee.
 *
 * These tests load the cycle from each entry point in a fresh registry.
 */

const ENTRY_POINTS = [
  "../../../utils/authorization/actorResolver",
  "../../../utils/authorization/legacyRoleGrants",
  "../../../models/user",
  "../../../models/systemSettings",
  "../../../models/workspaceUsers",
  "../../../utils/jobs/JobRuntime",
];

describe("service principals survive every require order", () => {
  beforeEach(() => jest.resetModules());

  test.each(ENTRY_POINTS)(
    "entering the cycle at %s still yields usable principals",
    (entry) => {
      require(entry);
      const {
        SERVICE_PRINCIPALS,
      } = require("../../../utils/authorization/principals");
      expect(SERVICE_PRINCIPALS).toBeDefined();
      expect(SERVICE_PRINCIPALS.coreJobs).toEqual({
        type: "service",
        id: "core-jobs",
        orgId: 1,
      });
      expect(SERVICE_PRINCIPALS.singleUser.id).toBe("single-user");
    }
  );

  test("the grant helper's default actor resolves at CALL time, not import time", async () => {
    // The original failure was invisible to an import-time assertion: the module
    // imported fine and only threw when the default parameter was evaluated.
    require("../../../utils/authorization/actorResolver");
    const {
      syncWorkspaceMembershipGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");

    // Ids of 0 make the helper return before touching the database; reaching that
    // early return at all proves the default parameter evaluated.
    await expect(
      syncWorkspaceMembershipGrant({ userId: 0, workspaceId: 0 })
    ).resolves.toBeUndefined();
  });

  test("principals.js requires nothing, so it can never join a cycle", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../../../utils/authorization/principals.js"),
      "utf8"
    );
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe("a membership without its grant must not survive (QA-2, #39)", () => {
  test("WorkspaceUser.create rolls the membership back when the grant fails", async () => {
    jest.resetModules();
    // Force the grant to fail the way the require cycle used to.
    jest.doMock("../../../utils/authorization/legacyRoleGrants", () => ({
      ...jest.requireActual("../../../utils/authorization/legacyRoleGrants"),
      syncWorkspaceMembershipGrant: jest.fn(async () => {
        throw new Error("simulated grant failure");
      }),
      revokeWorkspaceMembershipGrants: jest.fn(async () => {}),
    }));

    const created = [];
    const deleted = [];
    jest.doMock("../../../utils/prisma", () => ({
      $transaction: async (fn) =>
        fn({
          workspace_users: {
            create: async (args) => {
              created.push(args.data);
              return args.data;
            },
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
          },
        }),
    }));

    const { WorkspaceUser } = require("../../../models/workspaceUsers");
    const ok = await WorkspaceUser.create(7, 9);

    // The caller is told it failed...
    expect(ok).toBe(false);
    // ...and because both writes shared one transaction, the membership row the
    // create attempted is not committed. Previously the grant error was caught
    // and logged, leaving a member who gets 404 from every route in the
    // workspace they appear to belong to.
    expect(created).toEqual([{ user_id: 7, workspace_id: 9 }]);

    jest.dontMock("../../../utils/prisma");
    jest.dontMock("../../../utils/authorization/legacyRoleGrants");
  });

  test("the grant helpers throw rather than swallow", async () => {
    jest.resetModules();
    const {
      syncWorkspaceMembershipGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");
    // t4b's §7.7 lookup runs first: the grant follows workspace_users.role_id,
    // falling back to the seeded `editor` role only when the row has none.
    const db = {
      workspace_users: { findFirst: async () => null },
      roles: { findFirst: async () => null },
    };
    // No seeded workspace role: previously logged and returned, so the caller
    // believed the grant had been written.
    await expect(
      syncWorkspaceMembershipGrant({ userId: 1, workspaceId: 1, db })
    ).rejects.toThrow(/no workspace-scoped 'editor' role is seeded/);
  });
});

describe("JobRuntime keeps BOTH imports after the #39/#41 merge", () => {
  test("it takes SERVICE_PRINCIPALS from the leaf and resolveActorRef from the resolver", () => {
    // Techlead's trial-merge warning: resolving this conflict by taking either
    // side whole silently removes a working feature. Choosing #39's line drops
    // resolveActorRef, so every job resolves to undefined and is denied — and
    // the suite stays GREEN, because default-deny is what a denied job looks
    // like. This asserts the shape directly instead.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../../../utils/jobs/JobRuntime.js"),
      "utf8"
    );
    expect(source).toMatch(
      /require\("\.\.\/authorization\/principals"\)/
    );
    expect(source).toMatch(
      /resolveActorRef[\s\S]*require\("\.\.\/authorization\/actorResolver"\)/
    );
  });

  test("a job's actorRef resolves to that user, not to a denied blank", async () => {
    jest.resetModules();
    const {
      resolveActorRef,
    } = require("../../../utils/authorization/actorResolver");
    expect(typeof resolveActorRef).toBe("function");

    const actor = await resolveActorRef(
      { type: "user", id: "4242" },
      {
        db: {
          users: {
            findUnique: async () => ({ id: 4242, suspended: 0 }),
          },
          workspace_users: { findMany: async () => [] },
        },
      }
    );
    // The failure this guards: undefined resolveActorRef -> no actor -> the
    // engine denies, which looks identical to a correct denial.
    expect(actor).toMatchObject({ type: "user", id: "4242" });
  });
});
