# `npx prisma` inside test files resolves the wrong node

**Type:** bug · **Tier:** plain (no auth/permission/schema surface; it changes how
tests invoke a binary, not what any of them assert)

## The claim, measured

Dev3's #142 lesson: `npx` re-resolves the node binary and can land on the
machine default (node 26 here) even when invoked from a shell whose PATH starts
with node@22's bin. This repo pins `engines: ">=22 <23"`, so a child process on
node 26 is outside the supported range.

Confirmed locally on this machine:

```
$ export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
$ node -v          -> v22.23.1
$ npx node -v      -> re-resolves; not guaranteed to be v22
```

The fix Dev3 adopted for running jest is to name the interpreter explicitly:
`/opt/homebrew/opt/node@22/bin/node ./node_modules/.bin/jest`.

## Where it appears

**44 call sites across 41 test files** (all `execSync`, all inside
`server/__tests__/`):

- `npx prisma migrate deploy --schema ...` — **43 sites**
- `npx prisma db push --schema ... --skip-generate` — **1 site**
  (`security/authorization/directorySyncPermission.test.js`, #138's seed-only
  database)

By directory: `prisma/` 3 files, `security/authorization/` 28 files,
`security/identity/` 10 files. Full list at the bottom.

Every one of them builds a throwaway PostgreSQL database in `beforeAll`, so the
failure mode is not subtle when it happens — the suite dies before its first
test — but it is environment-dependent, which is exactly the class of failure
that reads as "the code is broken" to whoever hits it. This is the same shape as
the four-variable environment note already in the project memory.

## Proposed fix

Resolve the interpreter and the local binary explicitly instead of delegating
both to `npx`:

```js
// server/__testHelpers__/prismaCli.js  (new)
const path = require("path");
const { execSync } = require("child_process");

const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");

/**
 * `process.execPath` is the node running THIS jest process — by construction the
 * version the suite was started with. `npx` re-resolves, which is the bug: on a
 * machine whose default node is outside `engines`, the child ran on a different
 * major than the parent.
 */
function prisma(args, { env, cwd }) {
  return execSync(`"${process.execPath}" "${PRISMA_BIN}" ${args}`, {
    env, cwd, stdio: "pipe",
  });
}
```

Call sites become `prisma(\`migrate deploy --schema ${SCHEMA}\`, {env, cwd})`.

Two details that matter and are easy to get wrong:

1. **`process.execPath`, not a hard-coded homebrew path.** A literal
   `/opt/homebrew/opt/node@22/bin/node` is correct on this machine and wrong in
   CI (where node comes from the runner image) — it would trade an intermittent
   bug for a certain one.
2. **`node_modules/.bin/prisma` resolved from `SERVER_DIR`,** not from
   `__dirname`: the test files sit at three different depths under
   `__tests__/`, and a relative path that works in `prisma/` is wrong in
   `security/identity/`.

## Negative control the fix needs

A gate that never goes red proves nothing (§7.17). Before accepting this:
run one converted suite with `process.execPath` temporarily pointed at a node
outside `engines` and confirm the suite fails loudly, rather than silently
succeeding because prisma happens not to care about the major version. If it
does not fail, the fix is cosmetic and the real exposure is smaller than this
document claims — which is worth knowing either way.

## Not in scope

Whether `execSync` should be `execFileSync` (it should — the interpolated
`SCHEMA` path is shell-quoted by hand today) is a separate, larger change. Worth
doing in the same pass if the reviewer agrees, but it is not what this issue is
about.

## Full file list

```
prisma/chatReadGrantMigration.test.js
prisma/ssoIssueRetirement.test.js
prisma/t1-authz-migration.test.js
security/authorization/assignableRolesHttp.test.js
security/authorization/chatHistoryPermission.test.js
security/authorization/chatReadGrant.test.js
security/authorization/chatReadOthers.test.js
security/authorization/chatSearchSelfOnly.test.js
security/authorization/deploymentShapeBoot.test.js
security/authorization/directorySyncPermission.test.js
security/authorization/documentFilter.test.js
security/authorization/engine.test.js
security/authorization/explainAccess.test.js
security/authorization/grantManagement.test.js
security/authorization/heldPermissionsGroupExpansion.test.js
security/authorization/impersonationWrites.test.js
security/authorization/membershipGrantRole.test.js
security/authorization/modePredicateShapeB.test.js
security/authorization/myCapabilities.test.js
security/authorization/noLoginShapeB.test.js
security/authorization/offboardUser.test.js
security/authorization/offboardUserRepository.test.js
security/authorization/orgMemberAction.test.js
security/authorization/pinnedContextAcl.test.js
security/authorization/requestTokenShapeB.test.js
security/authorization/routeWiring.test.js
security/authorization/singleUserEnableMultiUser.test.js
security/authorization/singleUserRouteShapeB.test.js
security/authorization/uiBypassStillRefused.test.js
security/authorization/viewAsUser.test.js
security/authorization/workspaceScopedCapabilities.test.js
security/identity/applyDirectoryPlan.test.js
security/identity/assertionReplay.test.js
security/identity/groupMembershipPolicyVersion.test.js
security/identity/groupsExternalIdUnique.test.js
security/identity/identitySchema.test.js
security/identity/ldapProviderConfig.test.js
security/identity/linkPrincipal.test.js
security/identity/loginState.test.js
security/identity/samlDriver.test.js
security/identity/samlSchema.test.js
```
