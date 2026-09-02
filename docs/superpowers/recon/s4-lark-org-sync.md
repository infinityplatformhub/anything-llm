# S4 recon — Lark org sync

Author: Dev 3. Base `approof/main` @ `35e5b2095`. Seam: `docs/superpowers/design/seams/01-identity-provider.md`.

Backlog row: *"Lark org sync — user/แผนก → workspace/role + onboard/offboard อัตโนมัติ · S1, P0-5 · 3 cw"*.
Schedule lane B, month 4, paired with S12 offboarding.

This is recon, not a plan. It reports what the merged code already decided, what is
missing, and the questions PMO has to answer before an issue can be opened. Where it
says **BLOCKER**, an implementer starting today would have to guess, and guessing is
what §1 of the workflow exists to prevent.

---

## 0. The finding that changes the shape of S4

**A group grant does not authorize its members.** `principal_role_grants` accepts
`principal_type: 'group'`, the admin UI offers it (`endpoints/admin/authorization.js:41`,
`ASSIGNABLE_PRINCIPAL_TYPES = ["user", "group"]`), `documentFilter` and `explainAccess`
both expand group membership — but `DatabaseAuthorizationEngine.evaluate`, the function
every `authorize()` call goes through, queries grants for the **actor's own principal
type only** (`engine.js:170-183`). It never reads `group_members`.

Not read off the code — run, with a control, against a real migrated+seeded database:

```
action workspace.read: true scope=any
org admin role id: 1

group HOLDS org-admin (principal_role_grants principal_type='group'); user has NO direct grant
evaluate(workspace.read) -> {"allowed":false,"reason":"no_grants","matchedPolicyIds":[]}
CONTROL direct user grant -> {"allowed":true,"reason":"allowed_by_role","matchedPolicyIds":["role:1:49"]}
```

The control is the half that matters: the same role, same action, same actor, granted
directly, allows. So `no_grants` is specifically about the group edge, not about an
action that never allows. `grep -n group server/__tests__/security/authorization/engine.test.js`
returns nothing — the engine has no group coverage at all, which is why this has stayed
green.

Why it decides S4's shape: the obvious design — *sync a Lark department to a `groups`
row, grant the role to the group, and members inherit* — *does not work today*. It would
produce a sync that reports success, an admin UI that shows the grant, an `explainAccess`
that agrees the group holds it, and users who are denied. Every layer would corroborate
the wrong answer except the one that decides.

Three ways out, and this is the first thing to rule on (§6 Q1):

1. **Teach the engine group expansion.** One `group_members` read in `evaluate`, mirroring
   `documentFilter.js:73-81`. Correct, and it is where the rest of the system already
   assumes the meaning lives — but it changes the permission result of every existing
   group grant in a live database the moment it merges, which is a P0-5 authorization
   change, not an S4 change. It also puts a per-call query on the hottest path in the app.
2. **S4 writes per-user grants** and treats the group as bookkeeping. Nothing in the
   engine changes. The cost is that a department of 500 is 500 grant rows to add and
   revoke, reconciliation has to diff them, and two sources of truth (`group_members` and
   the grants) can drift.
3. **Materialize** — keep group grants as the authored form and expand them into user
   rows on write, in one place. Fast reads, one authored truth, but stale rows are now
   possible and something must own re-expansion.

My recommendation is (1) **as its own issue landing before S4**, not inside it. It is a
correctness fix to P0-5 that is true whether or not Lark is ever built, and it should get
its own RED proof, its own mutation pass, and its own review by whoever owns
authorization. S4 then builds on an engine that means what the admin UI says. Doing it
inside S4 hides an authorization change inside a connector feature, which is exactly the
shape that gets waved through.

---

## 1. What is already built and MUST be reused

**`linkPrincipal`** (`server/utils/identity/linkPrincipal.js`, 211 lines) is core, not a
driver, and it already owns everything S4 would be tempted to re-implement: conflict
policy (R1 — a new external identity whose email matches an existing account is refused,
never auto-linked), handle derivation, suffix retry, `syncLegacyRoleGrant`, and the
`identity_links` write. **S4 must not open a second path that creates users.** Its own
docblock says S13 wraps it rather than forking it; the same applies here.

Two things about it that constrain S4 directly:

- **It drops `principal.groups`.** The parameter is in the JSDoc, drivers populate it
  (OIDC from claims, SAML from the assertion, LDAP hard-codes `[]`), and `linkPrincipal`
  never reads it. `DEFAULT_ROLE = "default"` always, with the reason in a comment:
  *"R2 (PMO ruling): a first-time SSO user is a plain member. Group→role mapping is S4's
  job — 'the IdP said they are an admin' is exactly the claim a driver must not be
  trusted with."* So the hook is deliberate and reserved, and S4 is the ticket that
  cashes it. Whether the mapping happens in `linkPrincipal` at login or only in the
  reconciler is Q2.
- **It refuses unverified email** and refuses a second identity for an already-federated
  address. A Lark directory record is not a login assertion; it arrives with whatever
  Lark says. Feeding `listPrincipals` output through `linkPrincipal` unchanged means
  deciding what `emailVerified` means for a directory row — a real question, not a
  detail (Q3).

**`identity_links`** (`schema.prisma`) is the join: `@@unique([provider, subject])`, with
the comment *"Account linking is a database constraint, not application logic."*
`provider + subject`, never email, is the identity. Lark's `open_id`/`union_id` is the
subject; which of the two is Q4, and it is not cosmetic — `open_id` is per-application,
so picking it welds every link to one Lark app registration.

**`groups`** already anticipates this work: `source String @default("local") // 'local' |
'lark' | 'oidc' | 'ldap'` and a nullable `externalId`, `@@unique([orgId, name])`. Note
what is *missing*: there is **no unique constraint on `(orgId, source, externalId)`**, so
nothing at the database level stops two rows claiming one Lark department. A reconciler
that matches on `externalId` and finds two rows has no correct answer. The unique index
belongs in S4's migration.

**Job queue and worker** (`utils/jobs/PostgresJobQueue.js`, `CoreJobWorker.js`) are the
scheduling seam, and `CoreJobWorker.claim` already resolves the actor fresh on every
claim and refuses a deactivated one (T-4b W-5). A sync job therefore needs a durable
actor — Q5, and the answer shapes the audit trail for every membership change S4 makes.
Handlers are keyed `type@version`, so the job type is a versioned contract from the first
commit.

**Event outbox** (`event_outbox`, `utils/events/`) is how S12 will hear about departures
without S4 calling it directly.

**`CredentialStore`** (`models/credentialStore.js`, AES-256-GCM bound to its key name) is
where the Lark app secret goes. S3's `endpoints/identity/ldap.js` is the pattern to copy:
secret in the store, env var as bootstrap only.

---

## 2. What does not exist yet

- **No Lark code of any kind.** `grep -ril lark` outside `docs/` and `schema.prisma`
  returns nothing. S4 is the first driver to touch the API.
- **No directory-capable driver.** All three existing drivers declare
  `{directorySync: false, groupSync: false, deltaSync: false}` and throw
  `IdentityCapabilityError` from `listPrincipals`/`listGroups`. The seam names
  `LarkIdentityProvider` as *"first directory-capable driver for S4 org sync and S12
  offboarding"* — so S4 flips these flags to true for the first time, and the negative
  tests those three drivers already have become the model for proving the flags are
  honest.
- **No reconciler.** The seam assigns it to core, not the driver: *"Core reconciler maps
  principals/groups, authorizes membership changes, deactivates missing/tombstoned users,
  and owns sync checkpoints."* Nothing like it exists — this is the bulk of S4.
- **No sync checkpoint table.** `deltaSync` needs a durable cursor per provider.
- **No group→role mapping table.** Q2's answer decides whether one is needed.
- **No department→workspace mapping.** The backlog says *"แผนก map เป็น workspace"*;
  `workspace_users` has `user_id / workspace_id / role_id`, and nothing records that a
  membership came from a department rather than from a person clicking.
- **No LDAP↔Lark conflict handling.** The backlog pairs S3 and S4 without saying what
  happens when both are on (Q6).

---

## 3. The failure semantics are already written, and they are the hard part

The seam's last paragraph is the specification for the reconciler, and it is worth
reading as requirements rather than prose:

> *Directory page/checkpoint replay is idempotent. Invalid directory records are
> quarantined without widening membership; a partial/failed enumeration MUST NOT be
> interpreted as users having left. Deactivation occurs only from an authoritative
> tombstone or completed full snapshot.*

Three separate refusals, each guarding a distinct way an org sync destroys an
organization's access:

1. **Replay is idempotent** — a retried page must not double-write. The job queue gives
   at-least-once delivery, so this is not optional.
2. **A partial enumeration is not a departure.** Rate limit at page 7 of 12, and the naive
   "anyone not in the response has left" deactivates everyone in pages 8–12. This is the
   single most destructive bug available in S4 and the one the acceptance test must
   drive: *interrupt an enumeration mid-way and prove zero deactivations*.
3. **Deactivation requires a tombstone or a completed snapshot** — the positive form of
   (2). The reconciler needs to know it saw the whole directory before it may act on
   absence, which means the completeness signal is part of the checkpoint, not an
   inference.

Lark rate limits are the reason (2) is a live risk rather than a theoretical one: an org
of any size is many pages, and a 429 mid-enumeration is ordinary, not exceptional.

`documentFilter` reads `group_members` directly, so **membership changes move document
visibility**. A reconciler bug does not just misassign a role; it changes who can read
which documents. That puts S4 on the auth/permission path — Opus review plus
`security-review` per the model policy, and it is why the §0 finding cannot be quietly
folded in.

---

## 4. Files S4 would own

**New**
- `server/utils/identityProviders/LarkIdentityProvider/index.js` — driver:
  `tenant_access_token`, `contact.user.list`, `contact.department.list`, pagination,
  rate-limit backoff. Capabilities `{directorySync: true, groupSync: true, deltaSync: ?}`
  — the third depends on what Lark actually offers (Q7).
- `server/utils/identity/reconcileDirectory.js` — **core**. Takes `DirectoryPrincipal[]` /
  `DirectoryGroup[]`, decides users, groups, memberships, deactivations. Owns the
  completeness rule from §3.
- `server/jobs/sync-lark-directory.js` — the queue handler, versioned.
- `server/endpoints/identity/lark.js` — settings + a manual "sync now", `system.write`.
- Migration: sync checkpoint table; `@@unique([orgId, source, externalId])` on `groups`;
  whatever Q2 needs.
- Tests: driver against a fake Lark API (the S11 `__testHelpers__/smtp/server.js`
  precedent — a real server on an ephemeral socket, never `jest.mock`); reconciler against
  a real database.

**Modified**
- `server/utils/identityProviders/index.js` — register the driver.
- `server/utils/authorization/engine.js` — **only if Q1 lands as option (1), and then
  ideally in its own issue first.**
- `server/utils/identity/linkPrincipal.js` — only if Q2 puts mapping at login.

---

## 5. Dependencies

`S1` is merged (OIDC + `linkPrincipal` + `identity_links`). `P0-5` is merged
(`principal_role_grants`, `groups`, engine) **with the §0 gap**. `S12` depends on S4 and
is the consumer of its deactivation path — the two should agree on the tombstone contract
before either is built, or S12 inherits whatever S4 happened to do.

`V2` (Lark bot) depends on S4 for permissions: *"ผูกสิทธิ์ตาม S4"*. The bot's sequence
(`00-sequence-review.md` §3) calls `refreshPrincipal(external subject)` — which
`LarkIdentityProvider` will have to implement and all three current drivers throw on. If
V2 is wanted early, that method is the seam between them.

---

## 6. Open questions — PMO rulings needed before an issue opens

**Q1 (BLOCKER). Group grants do not authorize.** Fix the engine, write per-user grants,
or materialize? See §0. My recommendation: fix the engine, in its own issue, before S4.

**Q2 (BLOCKER). Where does department→role mapping live, and what is the mapping?**
`linkPrincipal` reserved it for S4 (R2) but did not say where. A table admins edit? Also:
what does an *unmapped* department produce — `default`, or no grant at all? R2's logic
says the IdP is not trusted to name roles, which argues for an explicit admin-authored
mapping and `default` for anything unmapped.

**Q3 (BLOCKER). What is `emailVerified` for a directory record?** `linkPrincipal` refuses
`emailVerified !== true` and calls it belt-and-braces. A `contact.user.list` row is not a
login assertion. Trusting the directory blanket-trusts Lark's tenant data; refusing means
directory-created users cannot be created at all. A third option — directory sync creates
users through a *different* core entry point with its own rules — is more honest but
means two creation paths, which R1 was written to avoid.

**Q4. `open_id` or `union_id` as `subject`?** `open_id` is per-application: choosing it
welds every `identity_links` row to one Lark app registration, and re-registering means
re-linking every user. `union_id` is stable across apps in one ISV. Whichever is chosen
is effectively permanent — the `@@unique([provider, subject])` rows are the account
mapping.

**Q5. What actor does the sync job run as?** `CoreJobWorker` resolves the actor per claim
and refuses deactivated ones. A `system` principal type exists in the
`principal_role_grants` comment. Every membership change S4 makes will be attributed to
whatever this is, so it is an audit decision as much as a plumbing one.

**Q6. LDAP and Lark both on — who wins?** S3 ships LDAP login; S4 brings a second
directory. Two systems can claim one person. Options: one authoritative directory per
org, per-provider precedence, or refuse the overlap. `identity_links` allows one link per
`(provider, subject)` and `linkPrincipal` refuses a second identity for an
already-federated *email* — so today the second provider to see a user is **refused**,
which is a defensible default but is currently an accident of R1 rather than a decision.

**Q7. Does Lark offer a delta/change API, or is every sync a full snapshot?** Decides
whether `deltaSync` is true, what the checkpoint stores, and how the §3 completeness rule
is even expressible. Needs a documentation check against the live API, not an assumption.

**Q8. Sync cadence, and what a "sync now" button is allowed to do.** Rate limits make an
admin-triggered full sync a self-inflicted 429 if unbounded. S11's mailer-test limiter is
the precedent — and the lesson from #80 is that mounting a limiter and testing it are two
separate claims.

---

## 7. Suggested split, if PMO wants one

S4 at 3 cw is too big for one issue. A shape that keeps each piece independently
provable:

1. **(pre-S4) Engine group expansion** — Q1. RED proof is the probe in §0 turned into a
   test. Own issue, own security review.
2. **S4a — driver only.** `LarkIdentityProvider` with `listPrincipals`/`listGroups`
   against a fake Lark server, capability flags honest, credentials in `CredentialStore`.
   No reconciler, nothing writes to `users`. Provable in isolation.
3. **S4b — reconciler.** Core, real database, and the §3 rules are its acceptance
   criteria: interrupted enumeration deactivates nobody; replay is idempotent; absence
   without a completed snapshot is not a departure.
4. **S4c — mapping and workspaces.** Department→role (Q2), department→workspace, admin
   UI. Needs mockups per workflow §1.5.

S12 attaches to S4b's tombstone path.

---

## 8. Evidence

- The §0 probe: throwaway database `s4_recon_probe`, `prisma migrate deploy` + `seed.js`
  on `35e5b2095`, real `DatabaseAuthorizationEngine` against real Prisma. Both the group
  case and the direct-grant control are quoted verbatim in §0. Database dropped and the
  probe script removed after the run; nothing left in the tree.
- Everything else is a citation to merged code, quoted with `file:line`.
- No code was written for S4. This branch is docs-only.
