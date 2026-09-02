# Techlead-1 — #137 Model Router gap: **option (2) — re-gate the entry on `model-router.read`**

**Skills invoked:** `superpowers:requesting-code-review` (design read of QA-3's oracle against
measured source); `security-review` checklist — privilege escalation, data exposure. `infi-lessons`
not invoked; no §7.17 line added here.

Read: `endpoints/modelRouter.js:15,29,52,74,92,112,138,162,183`;
`frontend/src/components/SettingsSidebar/index.jsx:286-290`;
`server/prisma/seeds/permissions.js:91-92,127-136`;
`prisma/migrations/20260902020000_t1_authz_schema/migration.sql:264-265,301-304`;
`prisma/schema.prisma:622-655`; `utils/authorization/policyRepository.js:294-311`;
`endpoints/system.js:115-125`.

---

## Ruling

**Option (2). Do not grant `model-router.*` to `setup_admin`; gate the sidebar entry on
`model-router.read`, the action its own routes check.**

## Why not (1) — and this is a security answer, not a scoping one

`model-router.write` is not "configuration". Measured: it writes
`model_router_rules.route_provider` / `.route_model` (`schema.prisma:652-653`) — the rule that
decides **which provider receives each chat**. A role holding it can point every matching
conversation at a provider of its choosing.

`policyRepository.js:298-301` states the design constraint in the code:

> *"`setup_admin` is deliberately content-free (T-1/T-6): it configures the instance and reads
> nobody's chats."*

Granting `model-router.write` would let a content-free role read everyone's chats — not by
querying them, but by redirecting them. That is the **same shape as the `audit.purge` finding an
hour ago**: a capability granted for one stated reason confers an unrelated authority under a
different action name, so nothing in the grant list shows the contradiction. Two instances in one
issue is not coincidence — it is what a grant assembled from "which menu entries came back" produces.

Model routing is also not "finish installation": an instance serves chat correctly with no router
configured (`fallback_provider`/`fallback_model` at `:626-627` are the un-routed path). It is a
steady-state cost/quality policy, which is `super_admin`'s.

## Why (2) is right rather than merely available

The entry is mis-gated **today**, independently of #137 — exactly as `system.logs.delete` was.
`SettingsSidebar/index.jsx:286-290` gates it on the same predicate as `llm`/`embedder`
(`system.write` after #121), while all nine routes ask `model-router.read`/`.write`. That was
harmless only while both were `super_admin`-only; #137 is the change that separates them, so #137
is where it gets fixed. #121's own rule: **a menu entry is gated on the action its route checks.**

## Scope — smaller than "touches frontend" suggests

1. `endpoints/system.js:115-125` — add `"model-router.read"` to `ORG_CAPABILITIES`. The list is
   deliberately fixed (`:1846-1849`), so a new UI gate needs its own entry; without this, `can()`
   returns undefined and the entry vanishes for **`super_admin` too**. This is the line the
   change fails on if it is written as a one-word frontend edit.
2. `SettingsSidebar/index.jsx:289` — gate on `model-router.read` instead of the shared predicate.

No migration change, no seed change. Against recon §6 ("frontend untouched"): §6 is a scope
statement, and a scope statement does not make a wrong gate right. Dev1's migration is unaffected —
which is the point, since the migration is the part that must land clean.

```
RF : setup_admin does NOT see the Model Router entry AND is REFUSED on
     GET /model-routers; super_admin sees it AND is allowed
mut : leave the entry on the system.write predicate
why : every "setup_admin's menu came back to 12 entries" fixture is green under the
      mutation — the mutation is what produces the 13th. Only an assertion naming
      this entry separates them. The super_admin half is what stops the fix from
      being implemented as "the entry is gone", which the capability-map omission
      above would silently produce.
```

## Residual to record, not to fix here

`model-router.read` joins `ORG_CAPABILITIES` while `mcp-server.*`, `agent-flow.*`,
`scheduled-job.*` and the other `API_ACTIONS` pairs (`seeds/permissions.js:80-92`) do not — so the
next entry gated on one of those hits the same undefined-capability trap. Worth one issue that
audits sidebar entry → route action across the whole file, rather than discovering it per grant.
