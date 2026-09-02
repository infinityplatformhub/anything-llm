# Recon — the ORG_CAPABILITIES prerequisite slice

Prerequisite for the sidebar entry ↔ route action audit (`contract-sidebar-audit.md`,
TL-2 998f4438a). Base `origin/approof/main` @ `a21e1be27`. **Read-only. No code.**

Everything measured by **querying the seeded `role_permissions`** on `approofworkspace` and by
**evaluating the capability lists out of `endpoints/system.js`** — not by reading either.

---

## Correction to my own number first: it is 10, not 12

The audit contract says "12 capabilities remain absent". Checked against **both** exposure lists
rather than only `ORG_CAPABILITIES`, and two of the twelve do not belong in this slice:

| action | in ORG_CAPABILITIES | in WORKSPACE_CAPABILITIES | verdict |
|---|---|---|---|
| `workspace.delete` | no | **yes** | **already exposed** — answered at workspace scope, where it belongs. Not missing. |
| `org.member` | no | no | **deliberately absent (#53)** — every principal of the org holds it, so a capability everyone has gates nothing. Must stay out. |

**The slice is 10 actions.** My "12" counted a workspace-scoped capability as missing because I
only checked the org list, and repeated `org.member` from the recon's raw output without applying
#53. Same class as the count errors already logged: a number reported without stating what it was
measured against.

## The 10, with holders from the seeded database

Queried, one row per action:

| action | holder(s) | unblocks sidebar entry |
|---|---|---|
| `browser-extension.read` | `super_admin:org` | settings.browser-extension |
| `browser-extension.write` | `super_admin:org` | settings.browser-extension (write controls) |
| `chat.write` | `super_admin:org` | settings.workspace-chats, settings.embeds |
| `embed.read` | `super_admin:org` | settings.embeds |
| `embed.write` | `super_admin:org` | settings.embeds (write controls) |
| `embed.delete` | `super_admin:org` | settings.embeds (write controls) |
| `invite.create` | `super_admin:org` | settings.invites (write controls) |
| `invite.delete` | `super_admin:org` | settings.invites (write controls) |
| `model-router.read` | `super_admin:org` | settings.model-router, settings.ai-providers, settings.llm |
| `model-router.write` | `super_admin:org` | settings.model-router (write controls) |

**Every one is held by exactly `super_admin:org` and nothing else** — count verified per action,
all 1. That is the finding that decides the risk question below.

## Does exposing any of these widen what `can()` answers for a role that should not see it?

**No — and this is the M2 trap in reverse, so it is worth showing the working rather than
asserting it.**

`ORG_CAPABILITIES` is the *vocabulary* of `GET /system/my-capabilities`; adding an entry does not
grant anything. The endpoint asks the engine per action and returns a boolean. So the only way
exposure widens visibility is if some role holds a newly-exposed action **and** currently holds
none of the exposed ones — such a role would gain a `true` it has no other route to.

Measured across every seeded role:

| role | holds of the 11 currently exposed | holds of the 10 candidates |
|---|---|---|
| `super_admin:org` | 11 | 10 |
| `setup_admin:org` | 4 | 0 |
| `content_moderator:org` | 3 | 0 |
| `member:org` | 0 | 0 |
| `owner:workspace` | 0 | 0 |
| `editor:workspace` | 0 | 0 |
| `viewer:workspace` | 0 | 0 |

(The `org.member` column is excluded — everyone holds it, and it stays unexposed.)

**Only `super_admin` holds any of the 10, and it already holds all 11 exposed actions.** No role
gains a capability the UI would newly reveal, and no role that answers `false` today starts
answering `true`. The widening risk is nil **on this seed**.

### Answering it directly: which of the 10 does any NON-super_admin role hold?

**None.** Queried explicitly rather than inferred from the table above:

```sql
SELECT r.name||':'||r.scope, p.action
  FROM roles r
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p  ON p.id = rp.permission_id
 WHERE p.action IN (<the 10>) AND r.name <> 'super_admin';
-- 0 rows
```

An empty result is also what a broken query returns, so two non-vacuity checks:
**10 grants exist in total across all 7 seeded roles** — matching one per action — and all 10
belong to `super_admin:org`. The zero is a real zero.

**Two different numbers are both correct, and the issue must not read them as conflicting.**
QA-3's per-role figures (27/25/1/0) count **sidebar ENTRIES a role can see** — rendered labels,
27 of them including `settings.privacy`. The figures above (11/4/3/0/0/0/0) count **ACTIONS a
role holds** out of the 11 currently exposed. Entries and actions are not in one-to-one
correspondence: several entries gate on the same action, and some gate on none. Neither number
converts into the other, and quoting one where the other is meant makes a correct measurement
look like a contradiction. RF-C is stated over **actions**, because that is what
`ORG_CAPABILITIES` changes; the entry count is what a user would notice, and belongs in the
issue's user-facing description rather than in the assertion.

**So the slice is a pure catalog change on this seed.** Nothing any role can see changes;
`can()` returns exactly what it returns today for every principal, because the only holder
already receives `true` for all 11 currently-exposed actions. The RF can therefore assert the
strongest available form:

> **RF-C: no role's visible capability set changes.** For every seeded role, the set of actions
> `/system/my-capabilities` answers `true` for is byte-identical before and after the slice —
> the answer map grows by 10 keys, all of them `false`, except for `super_admin` where all 10
> are `true` and were already reachable.

That is a stronger and cheaper assertion than an exception list, and it is only available
*because* the answer is none. If a later regrant makes it non-empty, RF-C goes red and the slice
needs the exception list instead — which is the right failure, not a nuisance.

**The caveat that matters more than the result:** that is a statement about the *default seed*,
not about a deployment. A customer who has granted `embed.write` to a custom role gets that role
a `true` it did not previously receive — correct behaviour, and still a visible change. Exposure
is not a grant, but it *is* a disclosure of what the grant already was. Say so in the issue rather
than shipping "no impact" measured on seed data alone.

## Test changes

### The literal list: 11 → 21, not 12 → 24

`workspaceScopedCapabilities.test.js:271` — `#121: ORG_CAPABILITIES is exactly this list` —
writes the members out and pins `toHaveLength(11)`. Adding 10 makes it **21**. (The contract's
"12 → 24" follows from the 12-figure corrected above; neither number is right.)

Both halves must change together, and the count is the point: the literal exists precisely so
that an addition is a deliberate edit here rather than a silent widening of what the endpoint
answers. A dev who updates the array and not the length gets a red that reads as a merge
artefact; one who updates the length and not the array gets a test that no longer pins anything.

### The derive-from-sidebar test keeps working, and gets stronger

`workspaceScopedCapabilities.test.js:236` reads the gated capabilities out of
`SettingsSidebar/index.jsx` and asserts every one is answered by the map. It is written to
**derive its expectation from the sidebar source** rather than restate it (§7.9f), so:

- it needs **no edit** for this slice;
- it goes **red on its own** if the audit issue re-gates an entry onto one of the 10 before that
  action is exposed — which is exactly the ordering this slice exists to enforce.

That is the check that makes "prerequisite" mean something mechanical rather than a note in a
plan. Its non-vacuity guard (`gatedOn.length > 5`) already prevents it passing on an empty scan.

**One thing to verify at implementation time, by running:** whether the three other tests that
touch `ORG_CAPABILITIES` (`orgMemberAction`, `uiBypassStillRefused`, `workspaceCapabilities`)
compare against the constant on both sides. TL-1 flagged that shape at checkpoint:655 — a check
whose expectation derives from the thing it inspects can never fail — and the literal list is the
repo's answer to it. If any of those three would stay green after a deletion, this slice should
say so rather than leave a fourth key-shape test that only appears to guard.

## Shape of the slice

Small in diff, wide in blast radius: one array in `endpoints/system.js`, one literal test, and
**+10 `authorizeMany` decisions on every `/system/my-capabilities` request** — the endpoint asks
the engine once per action. TL-1 noted the same cost for #121's four (checkpoint:655). Worth a
sentence in the issue; 21 sequential authorizations on a request every settings page makes is not
obviously free.

## Tier

**auth.** Touches `endpoints/system.js` and the capability surface. Full QA + Techlead verdict
before merge, per §7.11a.

## Sequencing

After #121, before the audit issue's guard conversions. The derive-from-sidebar test enforces the
ordering mechanically: convert an entry first and it goes red.
