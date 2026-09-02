# Techlead-1 — #112 O2b `43cf5da87` (auth half: `GET /system/preflight`)

11 files, +864/-6 across two commits (`259540acb` backfill coverage, `43cf5da87` the route and
step). Reviewed against my pre-read `techlead-112-preread.md`. Probes are in-process Node
against the shipped helpers; no suite run (§7.14).

**Verdict: PASS.** All five RED fixtures are present and each is red under the mutation it was
written for — verified below by naming the test that fails, not by trusting the list. Two
observations, neither blocking.

The two corrections to my pre-read are both mine to take: F1's gate direction (Dev5 was
right, and the SHA's comment records why better than I did), and the backfill, which
**already existed** — my RF-4 asked for work that was built long ago. Dev5 caught that by
reading the tree rather than the ruling and covered the existing code instead. That is the
right response to a wrong fixture.

## RF-by-RF: the mutation, and the test that goes red

**RF-1a — DB down + users exist → refused.** Red at
`a database that is down (RF-5) › still REFUSES an anonymous caller when users exist and the
users table cannot be read`.

The fixture induces the failure at `jest.spyOn(prisma.users, "count").mockRejectedValue(...)`
— the **prisma layer**, not the helper. The test's own comment names why, and it is the point
I would otherwise have raised: spying on `isConfirmedSingleUser` would test the mock, because
a gate rewired to `User.count()` never calls it, so the assertion would pass on exactly the
mutation it exists to catch. The comment records that the first version stayed green through
it. That is the difference between a fixture and a fixture that works.

**RF-1b — the transition, one process.** Red at
`the gate: pre-user OR system.write › closes to anonymous callers the moment a user exists,
in the SAME process`. It calls the route, creates a user, calls again — no restart, no fresh
app — and asserts `status !== 200` **and** `body.checks === undefined`. A module-level cached
boolean survives to the second call and goes red. This is the fixture I cared most about and
it is built the way it had to be.

**RF-2 — `system.read` without `system.write` → 403, no checks.** Red at
`refuses a caller holding system.read but NOT system.write, with no checks in the body`.

`mkSystemReader` builds the principal rather than borrowing a stock role, and the docblock
says why: measured, **no stock role holds `system.read` without also holding `system.write`**
(only super_admin carries either, and it carries both). Without building it the test would be
asserting that a user with no permissions is refused, which proves nothing about the gate's
choice between the two actions. Body asserted three ways — `checks` undefined, and the
serialised body does not contain `db.reachable`.

**RF-3 — credential in a `detail`, dotless host.** Red at
`the response carries no credential (RF-3) › removes a password quoted in a check detail on
host postgres:5432` (and `localhost:5432`), via `it.each`.

`db.internal` is deliberately excluded and the comment says why — the dot is what made #94's
first version pass by accident. Asserts the full password, the **8-character prefix**, the
username, and that the host survives. Dropping `scrubText` from the handler goes red on both
rows.

**RF-4 — backfill guard, asserted on the write.** Red at
`an instance that already has the row is NOT written again` and `running twice writes exactly
once`, both in `markOnboarded.test.js` (added in `259540acb`).

The ledger records the mutation that forced this shape: deleting the `isOnboardingComplete()`
early return left **all seven tests green**, because `lastUpdatedAt` does not move when a row
is rewritten with the same value — so a row comparison cannot witness "did not write". A spy
on `markOnboardingComplete` replaced it. That is the same self-satisfying-assertion class as
#94 F2, caught here only because the mutation was actually run. The third case I asked for
(fresh instance, no legacy signal, left alone) is present as its own test, and each arm of
`isLegacyOnboarded` gets its own `test.each` row.

**RF-5 — every check id present when the DB is down.** Red at
`reports every check id, with the downstream ones failed rather than absent`. Asserts
`ids` equals `CHECK_IDS` exactly and every check is `ok === false`. A handler filtering to
checks that ran fails on the array equality.

## The gate's shape

Three middlewares rather than a hand-rolled bridge, which is the right call and the comment
gives the reason: `requirePermission` keeps answering 403/404/503 exactly as it does
everywhere else, instead of a second implementation of its refusals living here.

The ordering point is subtle and correctly handled: `validatedRequest` sits **between** the
pre-user check and the gate, because it populates `response.locals.user` which `actorResolver`
reads — first would refuse the pre-user case, last would leave a real admin resolving to no
actor. The middleware that decides is `preUserOrGated`, and its catch answers **503**, not a
pass. `request.__preflightOpen` is set per request on the request object, so there is nothing
to cache across requests by construction.

The residual is in the code, not only the ledger, and it is stated as *deliberate and not to
be softened* with the CLI command that covers the case. That is the phrasing I asked for.

## OBS-1 — `blockersOf`'s test proves the classification is read, but one mutation slips

`takes level from the SERVER, not from the id or the ok flag` drives the same id with two
levels and asserts different answers. That is the right shape.

Measured one mutation it does not catch: a frontend that derived the classification from the
**id** (`!check.id.includes("locale")`) produces an identical blocker list for the real
nine-check payload, because today `db.locale` and `config.metrics_exposure` are the only
warns and both are id-distinguishable. The existing test *does* catch it — it uses a
synthetic `some.check` id precisely so no id-based rule can pass — so this is not a gap, it
is a note on why that synthetic id is load-bearing and must not be "tidied" into a real check
name later.

## OBS-2 — `GET /setup-complete` is the neighbour that did not get this treatment

The ledger records it as pre-existing, untouched, and raised as **#114** with the exposure
measured: 92 fields, credentials booleanised, but 33 raw `process.env` passthroughs including
twelve internal hostnames and filesystem paths — on a route with **no middleware at all**.

Correct not to fix it here (unknown callers, different issue). Worth saying plainly in this
issue's residual rather than only in the ledger: this SHA gates the *new* status route while
an older one beside it answers more, to anyone. A reader who sees the care taken here and not
the #114 link will assume the surface is closed.
