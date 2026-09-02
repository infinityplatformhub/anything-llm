# Techlead-1 — #136 slice 2 `6a379f735`: my three conditions from `6aabd6b7d` — **all met**, plus N-3

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
privilege escalation via a bypassed guard, audit integrity, stale-cache authz bypass.
`infi-lessons` not invoked. TL-2 owns the verdict; this confirms my conditions only.

§7.14: no suite run. Detached read at `/tmp/tl-136`, plus source greps.

---

**(1) No raw prisma write — confirmed by measurement, not by reading.** Grepped the whole
`offboardUser` body (`policyRepository.js:735-786`) for `deleteMany|create|update|upsert`:
**none**. The three `tx.*.findMany` calls are the enumeration and are reads. Every removal goes
through `removeGroupMember`, `revokeGrant` or `revokeDocumentAcl`, and the docblock names what
each primitive carries that a raw statement destroys — the group-row `orgId` scope derivation, the
read-before-delete that feeds `grant_revocations`, and the per-document bump key. **F9 is the
fixture I would have asked for and did not**: a user with *only* a membership, so
`removeGroupMember` is the only primitive called and `refuseGroupEscalation` is the only thing
between a `content_moderator` and stripping a super_admin group's membership. Its comment records
that F8 alone was insufficient — measured, `revokeGrant` refused the moderator first, so the suite
never noticed the membership guard had stopped running. F10 does the same for the ACL half by
asserting the **scope keys**, not a count, and records that the raw-`deleteMany` mutant passed the
whole file until it existed.

**(2) N bumps with rollback-scope F2 — confirmed, and the original fixture was correctly
replaced.** F2 no longer asserts a bump count; it injects a `document_acl.deleteMany` failure
through `prisma.$use` (chosen because middleware fires for transaction clients and a
`jest.spyOn` on `prisma.document_acl` does not — the right reason) and asserts the memberships,
grants, `grant_revocations` **and** `policy_versions` counts are all back at their pre-call
values. That is rollback scope, which is the property an outer transaction actually buys, and the
two audit-table assertions are the half a partial commit would leave describing a removal that did
not happen. The docblock carries my measurement — `inTransaction` inlines on a `tx`, so N is
correct rather than tolerated, and no reader observes an intermediate version because `head` does
not move until commit.

**(3) Enumerate-first idempotency with exact counts — confirmed.** `offboardUser` reads the three
row sets inside the transaction and drives each primitive from that list, so a row that does not
exist produces no call and no bump. F7 takes its baseline **after** the first offboard — which is
what makes `>= 0` useless and exact equality the only assertion with teeth — and pins
`policy_versions`, `grant_revocations` and `group_members` all unchanged across the second call.
The comment states why F1/F3/F4/F6 are green under the blind-call mutation.

**N-3 (actor resolved, not a constant) — met, with one honest limit worth recording.**
`makeActor(roleName)` creates a real user, grants a real role through `repository.grantRole`, and
returns `{type:"user", id, orgId:1}`; the guards then resolve that principal's permissions from
the database on every call. So no fixture asserts against a hardcoded actor, and F8/F9 prove the
guards run for real in both directions (refused for `content_moderator`, admitted for the
legitimate actor — F9 makes that explicit so the fixture is not satisfied by throwing always).
F11 refuses a missing actor and — measured, per its own comment — uses a user **with rows**,
because with `requireActor` deleted and an empty user the enumeration finds nothing and the
function returns cleanly.

The limit: `makeActor` builds the ref by hand rather than calling `resolveActorRef`, so the
`workspaceIds` field the real path derives (`actorResolver.js:212`) is absent from these fixtures.
Nothing in `offboardUser` reads it, so this is not a defect today — but it means these tests would
not catch a future primitive that starts depending on it. Worth one line in the ledger, not a
change here.

**Confirmed on all four. No conditions outstanding from me.**
