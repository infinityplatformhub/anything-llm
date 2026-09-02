# Recon — S4b: the directory reconciler

Dev 3. Docs only; no code written. Parent recon
`docs/superpowers/recon/s4-lark-org-sync.md` §3 and §7 item 3.

S4a (#113) shipped the driver: it enumerates and normalizes, and it writes nothing.
S4b is the half that decides — who exists, who belongs to what, and who has LEFT.
Everything below serves one asymmetry: **S4b's mistakes revoke access from people who
still work here, or grant it to people who do not.** The driver could only ever return
a wrong list; the reconciler acts on it.

**Q4 is not answered, and this recon does not answer it.** §7 states both branches with
their consequences and freezes neither. Everything in §1–§6 is decidable without it.

---

## 0. What S4a already guarantees, and what it deliberately does not

Worth stating because S4b's design leans on the first list and must not assume the
second.

**Guaranteed by the driver (#113, merged `1ac806cfc`):**

- A returned snapshot is COMPLETE. `listPrincipals` either returns every page or
  throws — `_enumerate` never returns a prefix, and a `cursor` argument is refused with
  `IdentityCapabilityError` rather than honoured, because a resumed enumeration is a
  prefix wearing a complete label (measured: 235 of 250 reported as `hasMore: false`).
- `hasMore` is always `false` and `nextCursor` always `null` on success. There is no
  partial success to interpret.
- `deltaSync: false`, honestly. Lark has no delta API, so every sync is a full snapshot
  and the §3 completeness rule is expressible only in those terms.
- `subject` is `user_id`, never `open_id`. A record without one is REFUSED, not skipped
  — a skipped principal is absent from the snapshot, and absence is how S4b decides
  someone left.
- `emailVerified` is always `false`. The driver states facts; the trust decision is
  S4b's (see §5).
- `memberExternalIds` on a group is EMPTY. Lark carries membership on the user record
  (`department_ids`), so S4b builds membership from principals, not from groups.

**Explicitly NOT provided:**

- No tombstones. Lark's `contact.user.list` does not return departed users, so
  "who left" is only ever derivable as absence from a completed snapshot.
- No change events S4b may act on. Lark's webhooks are scope-filtered and unreplayable
  (parent recon §7.2), so they can at most trigger a full sync, never substitute for one.
- No ordering or transactional guarantee across the two enumerations. Users and
  departments are separate calls; a department can appear in one and not the other.

---

## 1. The completeness rule, stated as a mechanism rather than a principle

The seam's requirement — *"Deactivation occurs only from an authoritative tombstone or
completed full snapshot"* — is the acceptance bar. There are no tombstones (§0), so:
**S4b may deactivate only from a snapshot it knows is complete.**

The driver's throw-on-failure gives us that for free at the boundary, and the design
must not squander it. Concretely:

1. **Both enumerations complete before anything is written.** `listPrincipals` and
   `listGroups` are separate calls; if the second throws, the first's result must not
   drive deactivation. The enumeration phase is therefore fully separated from the
   write phase — no streaming writes.
2. **Completeness is a recorded fact, not an inference.** The checkpoint stores that a
   given run completed both enumerations, not just how far it got. A later run must be
   able to distinguish "the previous run finished" from "the previous run stopped".
3. **The absence rule applies per-enumeration.** A user missing from a completed
   principal snapshot has left. A user missing because `listGroups` threw has not — and
   if the two are conflated, one Lark 500 deactivates the organisation.

The acceptance test the parent recon names — *interrupt an enumeration mid-way and
prove zero deactivations* — is necessary but NOT sufficient, and this is the sharpest
thing in this recon:

> A reconciler that deactivates nobody, ever, passes it.

So the interrupted-run test must be paired with a completed-run test on the SAME
fixture that proves the departed user IS deactivated. Neither test alone measures the
rule; together they pin it from both sides. This mirrors what #113 learned the hard
way: the RF-1 refusal tests were only meaningful because the 5,000-principal success
test ran beside them.

---

## 2. Enumerate → diff → apply, and where the transaction boundary goes

**Phase 1 (enumerate).** Call both driver methods. Any throw aborts the run with
nothing written. Record the failure; do not touch the checkpoint's "last completed"
marker.

**Phase 2 (diff).** Pure computation over the snapshot plus current database state.
Produces a plan: users to create, users to reactivate, users to deactivate, groups to
create/rename, memberships to add, memberships to remove. Being pure, it is testable
without a database and is where the completeness rule is enforced — the plan simply
cannot contain a deactivation if the run was not complete.

**Phase 3 (apply).** Writes the plan.

### The transaction question, answered against the constraints rather than by taste

One transaction for the whole run is the tempting answer and the wrong one at scale: a
5,000-user org is 100 pages and the write set is large; holding one transaction across
it means a long-running lock and an all-or-nothing failure where a single conflicting
row discards an entire correct sync.

The constraint that actually decides it: **`addGroupMember`/`removeGroupMember` already
bump `policy_versions` and publish to `event_outbox` inside their own transaction**
(#113, RF-5), and `bumpVersion` publishes inside the transaction deliberately so a
crash between commit and publish cannot leave caches stale forever. That machinery is
per-write and correct; wrapping the whole run in one outer transaction would collapse
every membership change into a single version bump, which is *not wrong* but discards
the per-change invalidation the cache subscriber consumes.

Recommendation (not a ruling — S4b's implementer should confirm against the applied
plan): **batch per entity, not per run.** Each user's creation/deactivation and each
membership change commits in its own transaction, and the checkpoint's "completed"
marker is written LAST, in its own transaction, only after every write succeeded. A
crash mid-apply then leaves a partially-applied sync that the next run corrects
(§3), rather than a rolled-back one that lost work it had already proven correct.

The one thing that must NOT be split: a membership write and its version bump, which
#113 already keeps together and S4b must not route around by writing `group_members`
directly. **S4b calls `addGroupMember`/`removeGroupMember`, never
`prisma.group_members.*`.** That is not style — it is the whole reason those functions
exist in `policyRepository`.

---

## 3. Idempotency

The queue is at-least-once (parent recon §3), so a replayed run is ordinary. Idempotency
here is cheap if the diff is honest, because **the plan is derived from current state
every time**: a replay re-reads the database, finds the previous run's writes already
applied, and produces an empty plan.

That gives idempotency by construction rather than by bookkeeping, and it is stronger
than a "have I seen this run id" check, which only protects against exact replays and
not against two overlapping runs.

Two places it can be lost, both worth a named test:

- **`upsert`, not `create`.** `groups` has `@@unique([orgId, source, externalId])`
  (#113) precisely so a re-created department collides rather than duplicating. A
  create-and-catch would work but hides the constraint; the unique index is the
  mechanism and the code should lean on it.
- **`removeGroupMember` on a non-member already bumps the version and returns
  cleanly** (#113 ruling), so a replayed removal is a no-op rather than an error.
  Verified in that slice; S4b inherits it.

**Concurrency is the gap.** Two overlapping runs each produce a plan from a consistent
read and then interleave their writes; nothing today prevents a second sync starting
while the first is applying. An advisory lock keyed on the org is the standard answer
and belongs in the contract as an explicit decision, not as an assumption.

---

## 4. Deactivate or quarantine

`users.suspended` (Int, default 0) is the existing mechanism; there is no `deleted_at`
or tombstone table. So "deactivate" means `suspended = 1`, which is reversible — an
important property given that the input is a directory that can be wrong.

Two distinct situations that must not share a code path:

- **Absent from a completed snapshot** → the person left. Deactivate.
- **Present but unusable** (no email at all, per S4a's `email: null`) → the record is
  invalid, NOT a departure. The seam says invalid records are *quarantined without
  widening membership*. Quarantine means: do not create the user, do not grant
  anything, surface it — and specifically do NOT deactivate an existing user whose
  directory record has degraded, because that turns a Lark data-entry error into a
  revocation.

Membership removal is the sharper edge. When a user is deactivated, their
`group_members` rows should also go — but through `removeGroupMember`, so the cache
invalidation fires. Leaving them would mean a reactivated user silently regains
everything, and #113's guard means these calls are permission-checked (§6).

**A scale guard belongs in the contract.** If a completed snapshot says 90% of the
organisation left, that is far more likely a misconfigured Lark app (wrong tenant,
narrowed scope) than 90% attrition. A threshold above which the run refuses and alerts
rather than applies is cheap insurance against the one failure that cannot be undone by
the next sync — because by then the sessions are revoked and the support tickets have
started. The threshold value is a product decision; the mechanism is not.

---

## 5. Two things S4a deliberately deferred to S4b

**`emailVerified: false` on every record.** `linkPrincipal` (R1) refuses
`emailVerified !== true`. Taken literally, directory sync can create nobody. The parent
recon's Q3 named three options; the user answered on #105 that `emailVerified` is
IGNORED for Lark-synced records. So the exemption lives in S4b's creation path and must
be visible AT the point it is granted, with an audit trail saying "created by directory
sync, address not proven" — not as a `true` laundered in by the driver, which is
exactly why S4a reports `false`.

**A user with no email at all.** S4a returns `email: null` rather than inventing one.
That record cannot be matched or created through the email-keyed path, so it is the
quarantine case in §4.

---

## 6. The actor, and why it is now load-bearing

The job runs as `SERVICE_PRINCIPALS.coreJobs`. Two things make this more than plumbing:

1. `CoreJobWorker` re-resolves the actor on every claim and refuses deactivated ones
   (`CoreJobWorker.js:14-19`), so the actor is a live authorization identity, not a
   label.
2. Since #113, `addGroupMember`/`removeGroupMember` run `refuseGroupEscalation`, which
   demands the actor hold what the group carries — **except for the two named exempt
   principals**, of which `coreJobs` is one. S4b is the first real caller of that path.

So the exemption S4b depends on is deliberate and tested (#113 RF-8 case 5, #128's
NIT-1 test pins that it is by NAME and not by "is not a user"). Worth stating in the
contract because it looks like an accident and is not: if someone later "tightens"
`isExemptPrincipal`, directory sync stops working, and the test that catches it is the
one QA-1 asked for.

Every membership change is attributed to `coreJobs` in the audit trail. That is
correct — the job made the change — but it means the audit answers "what changed", not
"which directory record caused it". If per-change provenance is wanted, it belongs in
the event payload and should be decided now rather than retrofitted.

---

## 7. Q4 — stated, not decided

**The question:** Lark and LDAP both claim one person by email. Today `linkPrincipal`
(R1) refuses a second identity for an already-federated email, so whichever provider
arrives second is refused. The user's answer on #105 was "**Lark wins**", which
contradicts current behaviour — under LDAP-first, Lark is refused today.

What is undecided is the SCOPE of "wins", and the two readings produce different
systems:

**(a) Lark wins only for never-linked accounts.** A local account with no
`identity_links` row may be claimed by Lark; an account already federated to LDAP stays
with LDAP and the collision is surfaced for an admin.
*Consequence:* no existing link is ever re-pointed, so the takeover shape R1 guards
never arises. Cost: an organisation migrating from LDAP to Lark must clear links
manually, and the sync reports conflicts it cannot resolve — indefinitely, on every run.

**(b) Lark wins always, re-pointing existing links.** A sync moves an
`identity_links` row from LDAP to Lark when the emails match.
*Consequence:* migration is automatic, and this is structurally identical to the
account takeover R1 exists to prevent — an attacker who can create a Lark directory
record with a target's email inherits that account. TL-1 noted the absence of a delta
API makes it worse: **every full sync is another opportunity to re-point**, so the
window is not a one-time migration but a permanent property. If (b) is chosen it needs
its own audit event, session revocation on re-point, and a same-tenant/verified-domain
precondition — none of which (a) requires.

**What is blocked until this is answered:** the driver's record shape (whether it must
carry enough to re-point), the matching rule in phase 2, and any test that pins either.
**What is not blocked:** everything in §1–§6. This recon deliberately keeps them
separate so S4b can start.

My recommendation, offered as input rather than a decision: **(a)**, with the conflict
surfaced loudly enough that a deliberate migration tool can be built later as its own
reviewed thing. (b)'s cost is paid continuously and silently; (a)'s is paid once and
visibly.

---

## 8. Suggested split

S4b is still large. Independently provable pieces:

1. **The diff, pure.** Snapshot + current state → plan. No database. The completeness
   rule lives here and is testable without any writes. Q4-independent.
2. **Apply, with the checkpoint.** Real database, real `policyRepository` calls, the
   idempotency and interrupted-run tests. Q4-independent.
3. **The job handler.** Versioned, `coreJobs`, scheduling, the advisory lock, the scale
   guard. Q4-independent.
4. **Identity matching and creation.** The `emailVerified` exemption, quarantine, and
   whatever Q4 decides. **Q4-blocked.**

1–3 can start now. 4 cannot.

---

## 9. Evidence

Every claim about current behaviour was read from the merged tree at `93f5d1769`:

- `identity_links` shape and `@@unique([provider, subject])` — `schema.prisma:401-415`
- `group_members` has no orgId of its own — `schema.prisma:842-850`
- `users.suspended` is the only deactivation mechanism; no tombstone table — grep for
  `checkpoint|sync_state|sync_run` in `schema.prisma` returns nothing
- Actor re-resolution and refusal of deactivated actors — `CoreJobWorker.js:14-19`
- Driver guarantees — `LarkIdentityProvider/index.js` and #113's ledger (slices 2, 4)
- The exempt-principal path S4b relies on — `policyRepository.js` `isExemptPrincipal`,
  with #113 RF-8 case 5 and #128's NIT-1 test as its proof

No code written. No database probe was needed for this one: every question it answers
was answerable from the schema and merged code, and the one thing that would need
measuring (concurrency behaviour under two overlapping runs) is named as a gap in §3
rather than guessed at.
