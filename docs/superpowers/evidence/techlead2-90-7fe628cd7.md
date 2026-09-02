# Techlead-2 review — #90 (O5a) `7fe628cd7` (Prometheus metrics at `/api/metrics`)

**Verdict: PASS.** Eight mutations run, all eight caught. The design decision that matters —
treating label *values* as the exposure rather than the numbers — is right and is enforced
rather than agreed. Two notes below, neither blocking.

Independent worktree `/tmp/tl2-90` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/qa3-90` (it carries `prom-client`, which this slice adds), `prisma
generate` run, Node v22.23.1. Per §7.14 no full-directory run. Worktree clean; all three
mutated files restored.

Baseline: **64 passed, 64 total**.

---

## The threat model is the right one

The module's header names the risk correctly: it is not the counters, it is the labels.
Prometheus labels are unbounded-cardinality plain text in every scrape, so a counter labelled
`{workspace: "acme-legal-due-diligence"}` publishes a customer's deal name to anyone who can
read the endpoint.

Both halves are closed — the label **names** and the **values** each may take — with the
reason stated: *"an allowed NAME with a free-text VALUE is the same leak wearing a different
hat."* That second half is the one a reasonable implementation would skip, and skipping it
would leave the hole entirely open.

`observe()` throws on an undeclared name or value rather than dropping the label and counting
anyway, and the comment explains why: dropping hides the mistake until someone reads a
dashboard and finds the dimension missing. Same for an unregistered metric — no create-on-first-use,
because a typo would become a metric that reports nothing and reads as a legitimate zero.

`provider` values are a **class** of integration, never an endpoint or model name, with the
reason given (a self-hosted URL is as identifying as a workspace title). That is the detail
that shows the rule was thought through rather than copied.

## The exposure is stated honestly, in the place it can be acted on

I verified the claim rather than taking it: `ipAllowlist` at `utils/middleware/requestControls.js:312`
is `if (entries?.length === 0) return next();` — an **empty allowlist allows everything**, and
empty is the default. So on an internet-facing box `/api/metrics` is public.

The route comment says this outright, and the doctor check (`config.metrics_exposure`) puts it
where an operator meets it while looking at their own configuration rather than in a boot log.
`warn` rather than `block` is the right level and the reasoning is sound: an instance on a
private network is fine as it is, and refusing to boot over a scrape endpoint would be worse
than the exposure.

The remedy text says what to set and why it matters — *"metrics hold no secrets, but user
counts, workspace counts and error rates are an inventory, and an inventory is
reconnaissance."*

## Mutations — 8 of 8 caught

| # | mutation | result |
|---|---|---|
| V1 | label **name** allowlist removed | **1 failed** |
| V2 | label **value** allowlist removed (name still checked) | **1 failed** |
| V3 | unknown metric returns silently instead of throwing | **1 failed** |
| V4 | `observe` drops labels and counts anyway | **1 failed** |
| D1 | `config.metrics_exposure` `warn` → `block` | **5 failed** |
| D2 | `configured` hardcoded `true` (the bug Dev5 found) | **2 failed** |
| D3 | whitespace-only allowlist counts as configured | **1 failed** |
| E1 | metrics route sets no `Content-Type` | **1 failed** |

V2 is the one I most wanted caught, and it is: the suite has a test named
*"does not leak a value through an allowed label either"*, which is exactly the half that
would otherwise pass on V1's back.

D2 is worth naming. Dev5 found that `configured = true` passed the three assertions that
existed at the time and added three tests that hold the judgement rather than its shape — the
check now fails when the allowlist is empty, passes when it is set, and treats whitespace-only
as empty. My D3 confirms the third of those is load-bearing rather than decorative.

D1 failing **5** tests rather than 1 is the right signature: a level change ripples into the
exit-code contract as well as the check's own assertion, which is how a doctor check should be
wired.

## The declared residual is accurate

The counters are defined and enforced, and **nothing increments them yet** — I grepped for
callers and found only the module's own definition and the route's `render`. So `/api/metrics`
currently serves prom-client's process defaults and five app counters that are all zero.

That is a coherent place to stop: the vocabulary and its enforcement are the part that is
expensive to retrofit, and wiring call sites afterwards cannot widen the label surface,
because `observe()` refuses anything undeclared. A call site added later either uses the
closed vocabulary or throws in the developer's face.

Worth stating in the residual, if it is not already: the five counters will read zero on a
live instance until that work lands, which looks identical to "nothing is happening" on a
dashboard. An operator who wires up a scrape now will see flat lines and may reasonably
conclude the endpoint is broken.

## NOTE — the suite needs a pgvector-capable database, which is not obvious

`doctor.test.js` fails one test against a plain `postgres:16`:

```
✕ VECTOR_DB spelling › no longer reports a spelling the app now accepts
```

because it asserts *no blocking check fails* while passing `vectorDb: "PGVECTOR"`, which makes
`ext.available` require the `vector` extension. Stock `postgres:16` does not ship pgvector, so
the check correctly blocks and the assertion fails. Against `pgvector/pgvector:pg16`:
**64 passed, 64 total**.

This is inherited from #74/#87 rather than introduced here, and the test is right — but the
dependency is invisible from the test name, and the failure reads as a metrics regression when
it is a container choice. A line in the suite header naming the requirement would save the
next reviewer the ten minutes it cost me.

## Reproduction

```
git worktree add --detach /tmp/tl2-90 7fe628cd7
cp -al /tmp/qa3-90/server/node_modules /tmp/tl2-90/server/node_modules
cd /tmp/tl2-90/server && npx prisma generate
docker run -d --name tl2-pgv -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t5 \
  -p 55490:5432 pgvector/pgvector:pg16
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55490/t5"
env -u VECTOR_DB -u IP_ALLOWLIST npx jest __tests__/endpoints/metrics.test.js \
                                          __tests__/scripts/doctor.test.js --runInBand
```

`env -u IP_ALLOWLIST` matters: an inherited value flips the exposure check and three tests
with it. Mutations were applied to working copies of `utils/metrics/index.js`,
`utils/doctor/index.js` and `endpoints/system.js`, each confirmed applied before its run and
restored immediately after (§7.9l).
