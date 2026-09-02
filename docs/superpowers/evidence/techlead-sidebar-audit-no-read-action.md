# Techlead-1 — sidebar audit: the five entries with no read action; and #138-perm's scope fix

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization action correctness, over-narrow gating, traceability of a security fix.
`infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout (read-only).

---

## (1) #138-perm `a4f2a5753`: **fixing all actions inside #138 is acceptable. Do not split it.**

Dev1 measured that my `category` note was wrong on this SHA and that the real gap is `scope` on
the **seed-only** path: `seed.js` never wrote it, so on a `db push + seed` deployment every
action — including `org.member` — was `any` rather than its declared scope. Accepted; my note was
about the column I checked, and they found the one that matters.

**Fix all actions, in this issue.** Three reasons, in order of weight:

- **A per-action fix is not smaller, it is wrong.** The defect is that `seed.js` does not write the column at all. `ACTION_SCOPES` for every action plus `update:` on the upsert *is* the fix; writing it for `directory.sync` alone would leave the seed still not writing scope, with one hardcoded exception — which is worse than the bug, because it looks fixed.
- **`org.member` at `any` on the seed-only path is a live authorization defect** (`#53`: an org-scoped question answered against a workspace resource is the migration-044000 vulnerability's shape, and `engine.js:166-176` raises a *contract error* precisely to stop it). Deferring it to its own issue leaves a known authz gap open on a real deployment shape for the length of another cycle. Traceability does not outrank that.
- **Traceability is satisfiable without a second issue.** The ledger line and the migration/seed comment name `org.member` and `#53` explicitly, and the cross-mutants (seed-only 3 red / migration-only 4 red) are the record that both paths were exercised. That is a better audit trail than an issue title, because it is next to the code.

**Condition:** the ledger must state plainly that #138 fixed a defect **outside its own scope**,
name `org.member` and `#53`, and say the seed-only path was verified with a real `psql` check.
Otherwise the next person reading `git log --grep '#53'` finds nothing. That is the traceability
cost, and one paragraph pays it.

## (2) The five entries with no read action: **guard on the write action. Do not invent read actions, do not leave them as residual.**

Measured — and the premise needs correcting before the options can be judged. **These pages are
not write-only. They have GET routes, and those GETs are already gated on the write action:**

```
GET /mailer/settings      requirePermission("system.write")   mailer.js:56-58
GET /admin/api-keys       requirePermission("key.manage")     admin.js:776-778
```

So there is no gap between what the guard would ask and what the routes enforce. Rule (a) says
*"an entry and its route guard name the same READ action"* — the read action **is** the write
action on these five, because that is what their read routes check. Gating the entry on
`system.write` / `key.manage` is not a compromise; it is rule (a) applied literally to what these
routes do.

**Why the "hides the page from a legitimate viewer" objection does not hold here.** It would hold
if a principal could legitimately read these pages without holding the write action — but none
can: the GET returns 403 for exactly the principals the entry would be showing the page to. Gating
the entry on anything broader reproduces #127 ("renders and cannot work") for those five rows,
which is the defect this audit exists to close. There is no viewer being excluded; there is a
403 being pre-empted.

**Why not add read actions (`mailer.read`, `key.read`, …).** That is a real change with a real
argument behind it — separating "see the SMTP host" from "change it" is a legitimate duty split —
but it is a **vocabulary and route change**, not a sidebar change: every new action needs a seed
entry, a migration, a grant decision per role, and the GET re-gated. Doing it inside a guard audit
means the audit issue decides five permission-model questions nobody scoped. And note the shape of
the one that matters: `GET /admin/api-keys` returns key metadata, and a `key.read` that is granted
more widely than `key.manage` is a decision about who can enumerate credentials. That belongs in
its own issue with its own review, exactly as `directory.sync` did.

**Why not residual.** "Keep the current tier as residual" leaves five entries gated by legacy
role strings while the other fifteen move to capabilities — two mechanisms in one file, which is
the state the audit is closing. These five are the *easiest* rows in the set, not the hardest:
their answer is already written in their route.

**Ruling: gate these five on the action their GET route checks** (`system.write` for mailer,
vector-database, transcription, branding; `key.manage` for api-keys — Dev4 confirms per row from
the harness, not from this list). **Record one residual, precisely scoped:** *"five settings pages
have no read/write split; their entries and routes both require the write action. Splitting them
(`mailer.read`, `key.read`, …) is a vocabulary change with a per-role grant decision — its own
issue."* That names the follow-up without doing it here.

```
RF : for each of the five, a principal holding the write action sees the entry AND the
     page's GET returns 200; a principal without it sees neither the entry nor a 200
mut : gate the entry on a broader action (e.g. settings.write where the route asks
      key.manage)
why : every "the entry appears for an admin" fixture is green under that mutation —
      super_admin holds both. Only a principal holding one and not the other separates
      them, which is the same discriminator #140's system.read-only principal provided.
```
