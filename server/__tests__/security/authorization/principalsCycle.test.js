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
