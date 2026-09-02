// #127 F7 — `system.read` belongs to `super_admin:org` and nothing else.
//
// This is the guard on the FIX, not on the bug. #127 was resolved by narrowing a client route
// guard (`ManagerRoute` → `AdminRoute` for /settings/mobile-connections) rather than by
// widening the permission, per TL-2's ruling. Nothing in the frontend can hold that decision:
// someone who wanted the manager case to "work" could grant `system.read` to `member` and every
// test in `mobileConnectionsGuard.test.jsx` would stay green while the mobile device list —
// including which users own which devices — became readable by every member of the org.
//
// So the constraint lives here, on the server, where the grant does.
//
// Reads the seeded database rather than the migration text: a later migration could add a grant
// without touching the file this would otherwise scan, and the question is what the deployment
// ACTUALLY grants, not what one file says.

const prisma = require("../../utils/prisma");

describe("issue 127: system.read is not granted beyond super_admin", () => {
  test("exactly one role holds system.read, and it is super_admin at org scope", async () => {
    const holders = await prisma.$queryRaw`
      SELECT r."name" AS name, r."scope" AS scope
        FROM "role_permissions" rp
        JOIN "roles" r ON r."id" = rp."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE p."action" = 'system.read'
    `;

    expect(
      holders.map(({ name, scope }) => `${name}:${scope}`).sort()
    ).toEqual(["super_admin:org"]);
  });

  test("no WORKSPACE-scoped role holds it", async () => {
    // Asserted separately from the exact-match above, because the two fail for different
    // reasons and a reader debugging one should not have to disentangle the other. A
    // workspace-scoped grant would be worse than an org-scoped one: `system.read` answers about
    // the instance, so scoping it to a workspace would imply a boundary it does not have.
    const workspaceHolders = await prisma.$queryRaw`
      SELECT r."name" AS name
        FROM "role_permissions" rp
        JOIN "roles" r ON r."id" = rp."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE p."action" = 'system.read' AND r."scope" = 'workspace'
    `;

    expect(workspaceHolders).toEqual([]);
  });

  test("the permission row exists — the query is not passing on an empty table", async () => {
    // Guards the guard. If `system.read` were renamed or removed, both assertions above would
    // pass against zero rows and report that nothing over-grants it, which is true and useless.
    const [permission] = await prisma.$queryRaw`
      SELECT "action" FROM "permissions" WHERE "action" = 'system.read'
    `;

    expect(permission?.action).toBe("system.read");
  });

  test("the routes this protects still ask for system.read", async () => {
    // The other half of the pairing: this file is only meaningful while the mobile routes are
    // gated on `system.read`. If they are re-gated to something else, the drift test above
    // keeps passing while guarding a permission nothing uses — and #127's client fix would be
    // pinned to a reason that no longer holds.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../endpoints/mobile/index.js"),
      "utf8"
    );

    const gated = [...source.matchAll(/requirePermission\("([^"]+)"/g)].map(
      ([, action]) => action
    );
    expect(gated).toContain("system.read");
  });
});
