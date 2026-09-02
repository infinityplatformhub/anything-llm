# Techlead-1 — #140 GREEN pre-read (uncommitted, `/tmp/red140`): nothing that would fail my verdict

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
unauthenticated disclosure, action correctness, fail-closed behaviour, single-user mode.
`infi-lessons` not invoked.

§7.14: no suite run. Read the two test files, the modified `endpoints/utils.js` and
`frontend/src/models/system.js`, and `actorResolver.js` / `validatedRequest.js` / `request.js`.

---

## Both folds applied, and applied for the stated reason

**Describe A is one test** (`:211`), asserting rejection status **and** the empty
`DISCLOSING_FIELDS` intersection together, with the reason written down: *"'we disclosed nothing'
and 'we refused' are halves of a single claim, and a suite where either can be green while the
other is red reports a route as safe that is not."* That is the finding restated correctly, not
just the edit.

**Engine and `resolveActor` are at module scope** (`utils.js:13-20`), with the comment naming the
three sibling files and the reason (no per-request state). `callerMaySeeStorage:132-148` is now
just the call, and stays fail-closed on `catch`.

## Nothing here would fail my verdict. Two things I checked specifically, both fine

**Single-user mode does not lose the version, and does not leak storage to an anonymous caller.**
This was the one shape that could have broken: `validatedRequest:22` calls `next()` in confirmed
single-user, so the route answers without a session — and `resolveActor:160-161` then returns
`SINGLE_USER_ACTOR`, which migration `20260902020000:419-422` grants `super_admin`. So a
single-user deployment gets `storage`, which is correct (there is one operator and they are the
admin), and it is reached through a **granted principal evaluated by the engine**, not a branch
that means "allow". Confirmed single-user requires the setting *and* zero user rows, so this is
not a door a multi-user instance can fall through.

**`baseHeaders()` sets `Authorization: null` when there is no token** (`request.js:14`) rather
than omitting the header. Worth knowing because the frontend stub keys on
`options?.headers?.Authorization` being falsy — `null` is falsy, so the stub still 401s, and the
real route still refuses. No issue, but it means the stub is testing "no usable token" rather than
"no header", which is the behaviour that matters anyway.

## One residual worth a line in the issue, not a change

The route is now session-gated, so **`/ping` is the only unauthenticated liveness surface** — the
route comment says so. Two things follow that the issue should record rather than leave implied:
external monitoring pointed at `/utils/metrics` breaks on upgrade (a real operational change, not
a bug), and `getGitVersion()` still shells out to `git rev-parse HEAD` **on every authorized
request** — unchanged by this issue, and fine, but it is now the kind of thing a member can
trigger in a loop where previously it was anonymous. Neither blocks; both belong in the residual
so the next person does not rediscover them as findings.

## Disposition

Ready for the verdict. Dev1's reported 8/8 + 3/3 with M1–M7 red on revert matches what the files
would produce, and the two folds are implemented as ruled rather than as edits that satisfy the
words.
