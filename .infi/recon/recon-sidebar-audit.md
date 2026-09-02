# Recon — sidebar entry → route action audit

TL-1 residual from #137 (f26c1b6db, 9d32ae768). Base `origin/approof/main` @ `a58d2167f`.
**Read-only. No code. Issue not opened.**

> **Scope superseded by `contract-sidebar-audit.md`** (TL-2 ruling 998f4438a). Measurements below
> stand, with the headline mismatch count corrected 19 → 20 and a sixth extraction bug recorded.

Everything below was **measured by mounting the real router and evaluating the real
`paths.js`**, not by grepping. The four harnesses are committed beside this file and rerunnable:

```
node .infi/recon/sidebar-audit-router.cjs      # mounted routes + their requirePermission actions
node .infi/recon/sidebar-audit-resolve.cjs     # sidebar entry -> href -> client route -> page
node .infi/recon/sidebar-audit-calls.cjs       # page -> server calls -> mounted actions
node .infi/recon/sidebar-audit-inhandler.cjs   # gates that live inside handler bodies
```
(Node 22 required — `package.json` engines is `>=22 <23`.)

---

## Headline

| measure | value |
|---|---|
| sidebar entries parsed | 37 occurrences → **29 distinct** (the same entry object is rendered in several branches) |
| mounted routes | **318**, of which **174** carry a `requirePermission` |
| entries where the guard's capability is **not among** the actions its page's routes ask | **20 of 29** (was 19 — see bug 6) |
| entries whose route actions are **all** in `ORG_CAPABILITIES` | **8 of 29** |
| distinct actions asked by these pages but **absent** from `ORG_CAPABILITIES` | **16** |

**The sidebar on main still gates on `roles: [...]`, not `capability:`** — 35 of 37 entries carry
a `roles` array and **zero** carry a capability. #121 converts this and has **not merged**
(`ORG_CAPABILITIES` on `a58d2167f` is still 7 entries). So this audit measures the *pre-#121*
state, and every row below is a question #121 answers or inherits. **It should be re-run on the
post-#121 SHA before the issue is written**, because the entry side of the comparison changes
wholesale.

---

## The mismatches

**Class A — the guard asks a capability none of the page's routes ask (19 of 29).**

`AdminRoute` asks `settings.write`; `ManagerRoute` asks `user.manage` (measured from
`PrivateRoute/index.jsx`). Neither is what most of these pages' routes actually check:

| entry | guard asks | routes ask |
|---|---|---|
| ai-providers / llm | settings.write | model-router.read, system.read, system.write |
| mailer | settings.write | system.write |
| vector-database | settings.write | system.write |
| embedder | settings.write | system.read, system.write |
| image-generation | settings.write | system.read, system.write |
| voice-speech | settings.write | system.read, system.write |
| transcription | settings.write | system.write |
| model-router | settings.write | model-router.read, model-router.write, system.* |
| community-hub trending | settings.write | system.read |
| community-hub import-item | settings.write | system.read |
| event-logs | settings.write | system.read, system.write |
| api-keys | settings.write | key.manage |
| embeds | settings.write | embed.read/write/delete, chat.*, org.member |
| mobile-app | settings.write | system.read, system.write |
| workspace-chats | user.manage | chat.read_others, chat.write |
| invites | user.manage | invite.create/delete/read, org.member |
| branding | user.manage | settings.write |
| browser-extension | user.manage | browser-extension.read/write |

Two of these are already known issues (mobile-app = #127/#132; event-logs and
default-system-prompt = #132's recorded residual). **The other 16 are the same defect shape and
have no issue.** The residual question #132 recorded — *read-with-A, write-with-B pages, which
guard?* — is not a corner case: **13 of the 19 have different read and write actions**, so it is
the normal shape here, not the exception.

**Class B — 16 actions these pages depend on are absent from `ORG_CAPABILITIES`:**

```
browser-extension.read   browser-extension.write   chat.write
embed.delete             embed.read                embed.write
invite.create            invite.delete             invite.read
model-router.read        model-router.write        org.member
system.read              system.write              user.read
workspace.delete
```

#121 adds four (`system.read`, `system.write`, `user.read`, `invite.read`). **Twelve remain**,
and `org.member` is *deliberately* absent per #53 — so the list is not simply "add them all".
The dispatch named `mcp-server.*`, `agent-flow.*`, `scheduled-job.*` as known-absent; none of
those appear here, because no sidebar entry's page calls them. That is worth stating plainly
rather than leaving as a silent non-result.

---

## Three classes of gate a router walk cannot see

The dispatch named one (`gateUnlessPreUser`). Measuring found **three**, and the second and third
would each have produced false "ungated" findings:

1. **Wrapped / constructed at request time** — `system.js:415`, `gateUnlessPreUser`. The gate is
   built *inside* a plain function, so the middleware does not exist until the request arrives.
   Exactly one instance in the codebase; it asks `system.write`.
2. **In-handler authorization** — `/system/api-keys` (`system.js:1624`),
   `/system/generate-api-key` (:1644), `/system/api-key/:id` (:1689) each do
   `if (response.locals.multiUserMode) return 401` in the handler body. A middleware walk sees
   only `[validatedRequest]`. **These are gated**, single-user-only, and reporting them as
   ungated would have been a false finding.
3. **Named middleware that is not `requirePermission`** — `isSingleUserMode`
   (`deploymentMode.js:49`) gates all of `/telegram/*` and `/scheduled-jobs/*`. Also a real gate.

Truly unauthenticated, after all three classes are accounted for: **`/setup-complete` and
`/utils/metrics`** (no middleware at all), and `/system/footer-data`, `/system/support-email`
(`validatedRequest` only, no permission). Those four are reached by nearly every settings page
and are almost certainly intentional — flagged for confirmation, not as findings.

---

## What went wrong while measuring — worth reading before trusting any similar audit

**Six** extraction bugs, each of which produced a **complete, plausible, wrong table**. None would
have been caught by reading the output; all were caught by checking a row I already knew.

1. **Leaf-name path resolution.** `paths.settings.llmPreference` and
   `paths.onboarding.llmPreference` both exist; a leaf regex returned the onboarding route for
   every settings entry. 37 rows, all wrong, all plausible.
2. **Namespace-then-leaf resolution.** Fixing (1) by matching the namespace first still failed:
   `settings:` appears at `paths.js:86` (inside `workspace`) *and* `:113` (top level), and first
   match wins. Fixed by **evaluating** `paths.js` instead of pattern-matching it.
3. **Transitive import walk.** Following imports from a page reached every method on every model
   it imported — a page making 3 calls reported 58. Fixed by resolving only the methods the page
   *names* (`System.foo(`) and reading those bodies.
4. **Arrow-only method matcher.** Models use both `foo: async () => {}` and
   `foo: async function () {}`. The matcher handled only the first, so 12 entries reported **zero
   calls** — including mobile-app, which is known to call two `system.read` routes. *Zero is the
   answer a broken extractor gives*, which is why unresolved methods are reported separately and
   never folded in as a real zero.
5. **Page-only scan.** Interface/Branding/Chat hold no calls themselves and delegate to
   `../components/*`; ApiKeys picks its model at runtime
   (`const Model = !!user ? Admin : System`, `ApiKeys/index.jsx:26`). Both reported zero until the
   walk followed local components and resolved the ternary alias.

6. **Model re-exports.** `models/system.js:1015` re-exports `promptVariables:
   SystemPromptVariable`, and pages call through it: `System.promptVariables.getAll()`. A
   `Local.method(` regex sees `System.promptVariables` with no `(` after it and drops the call,
   so `settings.system-prompt-variables` reported no server calls and was recorded as a
   non-mismatch. **Found by TL-2, not by me** — the second of these caught by someone else.
   Harness re-pointed at re-exports and rerun: exactly one entry hid this way, and the `indirect`
   field now records the hop so the path is auditable. Mismatch count 19 → 20.

Every harness now **fails loudly** rather than returning a degraded result: extraction that finds
nothing exits non-zero, and unresolved model methods are listed rather than counted as zero.
Current run: **0 unresolved, 0 entries with no calls, 0 calls with no mounted route.**

---

## Recommendation

**Do not open the issue yet**, for a reason beyond the instruction to hold: #121 rewrites the
entry side of every row here. Re-run the four harnesses on the post-#121 SHA, then scope from
that table. Sequencing it before #121 means writing a contract against a sidebar that is about to
be replaced.

When it is opened, the shape suggested by the data:

- The **12 remaining absent capabilities** are a prerequisite, not part of the fix — a guard
  asking any of them today refuses every caller including `super_admin` (the #132 precondition,
  same mechanism).
- The **read-with-A, write-with-B ruling** blocks 13 of the 19 rows. It needs answering first, or
  the issue converts the 6 easy rows and records 13 residuals, which is not an improvement over
  the current 19.
- A drift test belongs here: given the entry's capability and the page's routes' actions, assert
  they agree. That check is what this recon's harness already does, and turning it into a
  committed test is cheaper than the audit being redone by hand next time.
