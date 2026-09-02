# Techlead-1 — #112 O2b pre-read (auth half: `GET /system/preflight`)

Recon `docs/superpowers/recon/o2b-installer-ui.md` @ `22085ccc2`, read against `approof/main`:
`endpoints/system.js:266-292,500-540`, `utils/doctor/index.js`, `utils/diagnostics/index.js`,
`utils/authorization/actorResolver.js:317-324`, `models/systemSettings.js:856-885`.

No branch yet, so the RED fixtures below are derived from the code the route will sit on,
not from Dev5's implementation. Every one names a mutation I have confirmed is *possible*
against current main; where I could not confirm that, I say so rather than list it.

The recon is right about the shape. The permission ruling (`system.write`, not `system.read`)
is correct and the reason given — `permissions.js:59` — is the same line #94's ruling 1 turned
on. Four findings, then the fixtures.

---

## REQUIRED RED FIXTURES

Format: `fixture / mutation it must catch / why the obvious fixture goes green anyway`.

**RF-1 — the transition, measured in one process, with no restart between**
```
fixture   : call preflight unauthenticated → 200; create the first user via the real
            onboarding path; call preflight again with NO auth → must be 401/403
mutation  : cache the "no users yet" answer (a module-level boolean, a memoised
            isConfirmedSingleUser, a `let installed` set at boot)
green why : a fixture that restarts the server, or builds a fresh app per test, re-reads
            the count on the new process and passes against every caching bug there is.
            The whole defect is that the answer is remembered ACROSS the transition, so
            the test must not create a new process at the moment the transition happens.
```
This is the fixture I care most about. `isConfirmedSingleUser` (`actorResolver.js:317-324`)
already re-reads `users.count()` per call and caches nothing — the correct behaviour is
available for free. The failure mode is a well-meaning optimisation added later, and only a
same-process transition test catches it.

**RF-2 — `system.read` is refused, driven through the engine, not a role name**
```
fixture   : an actor holding system.read and NOT system.write, on an instance that HAS
            users, asserting 403 AND that the response body carries no `checks` array
mutation  : change the gate to requirePermission("system.read", orgResource)
green why : a fixture using a role that happens to hold neither permission passes
            against both gates. The actor must hold system.read for real — assert that
            through the engine in a premise guard first, the way #84's suite does, or
            the test proves nothing about which permission was asked for.
```
Assert the **body**, not only the status: a 403 whose body still contains the checklist is a
real shape (an error handler that serialises what it had) and status-only assertions miss it.

**RF-3 — a credential in a `detail` string, on a host with no dot**
```
fixture   : DATABASE_URL = postgresql://appuser:PW@postgres:5432/x (the docker-compose
            host), forced connection failure so db.reachable's detail quotes it;
            scan the WHOLE serialised response for PW and for PW.slice(0,8)
mutation  : drop the scrubText call from the route
green why : `db.internal:5432` passes without any scrub at all — redaction.js's EMAIL
            pattern needs a dot in the host, and that accident is what hid this in #94.
            A dotted-host fixture is green against a route with no redaction whatsoever.
```
Measured in #94 and unchanged: `postgres:5432` and `localhost:5432` — the hosts
docker-compose and CI actually ship — leak in full without `scrubText`. The route must use
`scrubText` (now exported from `utils/diagnostics`), not `scrubValue`, for exactly this
reason. Include the 8-character prefix assertion: a partial redaction passes a whole-value
check.

**RF-4 — the backfill guard row, driven twice in one process**
```
fixture   : instance with users and NO onboarding_complete row → run backfill → row is
            "true"; run backfill AGAIN in the same process → assert _updateSettings was
            NOT called a second time (spy), not merely that the value is unchanged
mutation  : remove the guard-row check, keeping the "already complete?" check
green why : re-running against a row that already says "true" leaves the value identical,
            so a value-only assertion is green whether or not the guard exists. The
            claim is "does not run twice", which is about the WRITE, not the value.
```
Third case in the same fixture: an instance with **no users** and no row must be left
untouched — a backfill that fires there marks a genuinely fresh install as already
onboarded and the operator never sees the installer at all. That is the expensive direction
and it needs its own assertion.

**RF-5 — a check that could not run must not read as passing**
```
fixture   : database unreachable; assert every check in CHECK_IDS is present in the
            response and that db.version / ext.available / ext.permitted / db.locale
            come back ok:false, not absent
mutation  : filter the response to checks that ran
green why : a healthy-database fixture returns all nine checks either way. The route only
            diverges when something is broken, which is the situation it exists for.
```
`runChecks` already returns `ok:false` with `"Not checked: the database could not be
reached"` for the four downstream checks (`doctor/index.js:420-433`) — the comment there
says a check that could not run must never report success. The route must not undo that by
filtering, and the UI must not treat an absent check as a passing one.

---

## Findings

**F1 — "follow the same rule `GET /onboarding` follows" resolves to *no rule at all*, and
the recon's own warning is the reason this must not be inherited.**

Measured: `app.get("/onboarding", …)` (`system.js:266`) has **no middleware whatsoever** —
not `validatedRequest`, no gate. It answers a single boolean (`onboardingComplete`), which is
why that has been acceptable. `POST /onboarding` is `[validatedRequest,
requirePermission("settings.write", orgResource)]`.

So the two routes the recon points at do not share a rule to follow; they sit at opposite
ends. Copying the GET's shape gives an **unauthenticated system-status route for the life of
the instance**, which is precisely the outcome the recon says to read carefully rather than
assume. The preflight body is nine `detail` strings naming hosts, paths, uids and extension
state — not a boolean.

What I would ask for instead, stated as the rule rather than as a reference to another route:

> The route answers **either** when the instance has no users at all (`User.count() === 0`,
> the ruling-C signal), **or** when the caller holds `system.write`. Never on any other
> basis, and the two conditions are evaluated per request.

`User.count() === 0` rather than `isConfirmedSingleUser` deliberately: the latter also
consults `SystemSettings.isMultiUserMode()`, which catches its own errors and returns
`false` (#46's swallowed-error hole), so an unreachable database would make it answer
"single user" — and an unreachable database is exactly the state a preflight runs in. The
ruling-C branch at `system.js:516` uses the bare count for the same reason, and its comment
says why: user rows present means the instance is multi-user whatever the setting says.

**F2 — the onboarding window is not "before onboarding completes", it is "before the first
user exists", and those differ by a long time.**

`onboarding_complete` is written by `POST /onboarding` at the *end* of the flow, after the
LLM and embedder steps. The first user is created much earlier. If the route keys on
`isOnboardingComplete()`, it stays open across the whole configuration flow on an instance
that already has an admin — including after that admin logs out. Keying on `User.count()`
closes the window the moment there is somebody who could have been asked to authenticate.

This is worth stating in the issue because both readings are defensible from the recon's
text, and they produce very different exposure windows.

**F3 — `config.metrics_exposure`'s detail is the one check whose *passing* answer is
sensitive.**

Of the nine checks, eight leak configuration when they fail. This one leaks when it
**passes**: `"IP_ALLOWLIST is set, so /api/metrics is reachable only from the addresses it
names."` — and when it fails, `"IP_ALLOWLIST is empty, which allows every address.
/api/metrics is unauthenticated, so anything that can reach this port can read the
instance's counts and error rates."`

That failing string is an accurate description of an open door, delivered to whoever asks.
On an instance in the unauthenticated window it is fine — there is nobody to protect from
yet. After F1's gate it is behind `system.write`, which is right. I raise it only so the
decision is deliberate: if anyone later proposes relaxing the gate to `system.read` "because
it is only a checklist", this is the check that makes that wrong.

**F4 — `scrubText` is the right tool and it is now exported; say so in the issue.**

`utils/diagnostics/index.js` exports `scrubText` as of #94 `477eb0993`. It strips
`scheme://userinfo@` **then** runs `scrubValue`, and redacts the account the pg driver names
in prose. `scrubValue` alone is not sufficient — that is FINDING-1 from #94, measured. Name
the function in the issue so this does not get re-derived as "run the response through
redaction.js".

One caveat to carry: `scrubText` over-redacts quoted English after `user`/`role` (measured
in #94: `the user "guide" explains this` → `[redacted]`). Against the doctor's current nine
`detail` strings the cost is **zero** — I drove all of them and none changed. But the
preflight response is the first place those strings are read by a non-operator, so if a
future check's remedy uses that phrasing it will arrive redacted and look like a bug.

---

## Not assessed

The React step, the blocking-vs-warn behaviour in `Steps/index.jsx`, and the remedies-as-data
rule are the `plain` half and outside what I can usefully check without the branch. The
recon's insistence that remedies come from `runChecks` rather than JSX is right and I have
nothing to add to it.
