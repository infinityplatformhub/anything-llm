# Techlead-1 — #137 ruling: `DELETE /system/event-logs` under `system.write`

**Skills invoked:** `superpowers:requesting-code-review` (design read of the recon against
measured source); `security-review` checklist — audit-trail integrity, privilege escalation,
data exposure. `infi-lessons` not invoked; no §7.17 line added here.

Read: `endpoints/system.js:1742-1766` (both event-log routes),
`endpoints/audit/index.js:80-99`, `prisma/migrations/20260902050000_t6_audit/migration.sql:1-23`,
`prisma/schema.prisma:301-311`, `prisma/seeds/permissions.js:128-138`.

---

## The finding is real, and it is sharper than "delete what you cannot read"

Confirmed at source. `system.js:1763-1765` gates `DELETE /system/event-logs` on `system.write`.
`:1742-1744` gates `POST /system/event-logs` (the read) on `system.read`. Both are in #137's grant
set, so after #137 `setup_admin` can both read and delete them — the recon's framing understates
its own case by focusing on the read.

The sharper version: **`audit.read` protects the same rows.** `endpoints/audit/index.js:99` reads
`EventLogs.where(...)` — the audit export and the event-log endpoints are two views of one table
(`schema.prisma:301`). And `20260902050000_t6_audit/migration.sql:9-12` grants `audit.read` to
**`super_admin` only**, with the reason written out:

> *"the audit log is the record of what everyone did, including the people who administer the
> system... content_moderator reads chats and setup_admin manages access, and neither needs the
> trail of the other."*

**That migration names `setup_admin` explicitly as a role that must not read the audit trail.**
#137 as proposed would let it delete that trail. Granting delete over rows a prior decision
deliberately withheld read on is not a side effect — it contradicts a recorded ruling, and it does
so through a different action name so nothing connects them.

## Ruling: **split it. `system.logs.delete` comes off `system.write` in #137, and `setup_admin` does not get it.**

Rejecting the other two options:

- **Accept** — cannot. A role that can erase the record of its own actions has no accountability, and this role is precisely the one that *manages access* (`settings.write, user.manage, role.grant, role.revoke`). The audit trail is the only thing that would show a delegated admin granting themselves something; letting them delete it removes the sole control on the most sensitive permission set in the seed. This is the classic anti-forensics escalation and it is not a theoretical one here.
- **Grant a narrower set (drop `system.write`)** — that is the tail wagging the dog. `system.write` is what `/system/update-env` checks (`:1077`), and enabling `setup_admin` to finish an installation *is* #137's whole purpose. Dropping it to avoid one route defeats the issue.

The split is small, and it is the option that fixes the actual defect rather than routing around
it: `system.write` is currently doing two unrelated jobs — configure the instance, and destroy its
audit trail. Those belong to different people. **This is true independently of #137**; #137 merely
makes it reachable by a second role, which is why it is the right issue to fix it in.

**Scope:** one permission row, one gate change at `system.js:1765`, granted to `super_admin` only
(the CROSS JOIN in `20260902020000` covers permissions existing *then*, so a new row needs its own
grant — the pattern `20260902040000..043000` and `20260902050000:18-22` already establish).
`super_admin` therefore loses nothing and `setup_admin` gains nothing it should not have.

**Where I would not go further:** `POST /system/event-logs` (the read) stays on `system.read` in
this issue. It is arguably also mis-gated relative to `audit.read`, but changing it would *remove*
access that `super_admin` and others have today, which is a behaviour change with its own blast
radius. Record it as a residual: **`system.read` and `audit.read` both grant read over
`event_logs`, and the narrower one is not enforced on the wider path.** That is a real
inconsistency and it deserves its own issue rather than a rider on this one.

```
RF : setup_admin is REFUSED on DELETE /system/event-logs after #137, and ALLOWED on
     POST /system/update-env in the same test file; super_admin is allowed on both
mut : leave DELETE on system.write
why : every "setup_admin can now configure the instance" fixture is green under the
      mutation — that is what #137 grants. Only an assertion on the delete route
      separates the intended grant from the accidental one. The super_admin control
      is what stops the split from being implemented as "nobody may delete".
```

## The count note: both numbers are right, and they measure different things

Asked to confirm. Measured across `endpoints/`:

```
requirePermission("system.read"   → 15
requirePermission("system.write"  → 22
```

15 matches the recon's route-table figure exactly. My `system.write` count is 22, not 21 — one
more than reported. The `system.read` sites spread across five files
(`communityHub.js` 4, `system.js` 7, `experimental/liveSync.js` 1, `mobile/index.js` 2,
`utils/foundryUtilsEndpoints.js` 1), so a count taken from `system.js` alone would report 7.

QA-3's 12 is a **call-site** count — where the frontend actually calls — and is necessarily
smaller than the number of mounted routes, because routes exist that no current UI reaches. Both
are correct; they answer different questions, and the issue should say which it means where. The
one that matters for #137's blast radius is the route-table count, since a granted permission
opens every gated route whether or not a UI calls it — the `DELETE /system/event-logs` finding is
exactly a route the frontend count would have hidden.

**Worth reconciling the 21 vs 22 before the contract is final**; if the recon's count excluded
something deliberately, the exclusion should be named.

## The second defect (`user.manage` without `user.read`) — agreed

`setup_admin` holding `user.manage` but not `user.read` means it can mutate users it cannot list.
Granting `user.read` is right, and it is worth stating in the ledger that the two are separate
permission ids with no containment relationship — the broader-sounding name grants nothing about
the narrower, which is the same trap I flagged in #123.

## Not granting `system.env.read` — agreed, and the deny test is the important half

Withholding it is right: reading raw environment values is a different question from writing
configuration through a validated endpoint. The recon already plans deny assertions for
`system.env.read` and `audit.read`; those are what stop the migration from being written as "grant
setup_admin everything it seems to need". Keep both, and add the `system.logs.delete` deny
alongside them.
