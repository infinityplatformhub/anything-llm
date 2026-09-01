# Hotfix #39 — SERVICE_PRINCIPALS undefined inside a require cycle

Author: Dev 2. Base `b2a578c5`. Branch `approof/hotfix-principals-cycle`.

## The bug

```
models/user → utils/authorization/legacyRoleGrants → utils/authorization/actorResolver
            → models/systemSettings → utils/http → models/user
```

`actorResolver` exported `SERVICE_PRINCIPALS`. Whichever module in that cycle loads
first hands the others a half-built `exports` object, so the import binds `undefined`.

It did not fail at import. `SERVICE_PRINCIPALS.coreJobs` is a **default parameter** in
`syncWorkspaceMembershipGrant`, evaluated at CALL time — and the caller catches and logs
errors so a grant failure never breaks the surrounding write. Net effect: **a new
workspace member silently received no grant**, and after T-4a made grants load-bearing
that means no access to the workspace they were just added to.

Reproduced verbatim:
```
$ node -e "require('./utils/authorization/actorResolver');
           require('./utils/authorization/legacyRoleGrants')
             .syncWorkspaceMembershipGrant({userId:0,workspaceId:0})"
Warning: Accessing non-existent property 'SERVICE_PRINCIPALS' of module exports inside circular dependency
THREW: Cannot read properties of undefined (reading 'coreJobs')
```

Production survived only because `index.js` happens to load `models/user` first. That is
an accident of import order, not a guarantee — and it is exactly the kind of thing a
refactor elsewhere silently changes.

## The fix

`utils/authorization/principals.js` — a leaf module that **requires nothing**, so it
cannot join a cycle and its constants are always fully formed. `actorResolver` re-exports
them so existing importers keep working; the two consumers inside the cycle
(`legacyRoleGrants`, `JobRuntime`) import from the leaf directly.

## Tests

`__tests__/security/authorization/principalsCycle.test.js` — enters the cycle from each
of 6 entry points in a fresh module registry and asserts the principals are usable; one
test calls the helper so the DEFAULT PARAMETER is actually evaluated (an import-time
assertion would have passed against the broken code); one asserts `principals.js` contains
no `require(` at all, so it cannot be dragged back into a cycle later.

**RED proof**: with the fix stashed, all 6 entry-point cases fail. With it, 948/948 pass.

## Scope

5 files: 1 new module, 1 new test, 3 one-line import changes. No behaviour change beyond
the constants being reliably defined.
