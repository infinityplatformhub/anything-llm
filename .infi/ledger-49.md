# ledger — #49 server-minted embed session

Branch `approof/49-embed-session`, base `4d8e16d90`, SHA `2c9ae1f0f`.
Recon: `.infi/recon/recon-49.md`. Contract: 72/72 on the five embed suites.

---

## Rulings

Ruling: `mintIfEntitled` KEEPS rotation and loses only the free-mint branch — because rotation
opens no new hole (it demands a valid token for the very session it refreshes, which is the
proof the whole scheme rests on), and without it an ongoing conversation is logged out at the
24h TTL mid-thread. If wrong: a STOLEN token could be renewed indefinitely, since rotation
alone binds no maximum lifetime. That consequence was raised as a residual and then closed
inside this issue — see the next ruling.

Ruling: a session gets an ABSOLUTE ceiling of 7 days. `firstIssuedAt` is a fourth element in
the signed payload; rotation carries the original through unchanged; verification refuses once
`now - firstIssuedAt > 7d`, reported as `expired` — the same answer as the TTL, because telling
them apart would reveal how long ago the session opened to a caller who cannot prove it is
theirs. Without it the 24h TTL is a rolling window rather than a deadline. If wrong: a
conversation genuinely spanning more than a week starts a new session — visible and
recoverable, unlike an unbounded stolen credential. Mutation-verified twice, on two DIFFERENT
tests: restarting `firstIssuedAt` on rotation fails one, removing the ceiling fails the other.

Ruling: `EMBED_REQUIRE_SESSION_TOKEN` stays presence-based (`"KEY" in process.env`), so
`=false` and `=` both ENABLE it. The failure directions are not symmetric: under boolean
parsing a typo (`=ture`, `=0`, `=off`) silently DISABLES a gate the operator believes is on and
nothing says so, while presence-based the worst case is an unexpected 401 — visible within
minutes. Same convention as `EMBED_REQUIRE_ALLOWLIST` beside it. If wrong: an operator who
writes `=false` meaning "off" gets "on" — a support ticket, not a breach. Now asserted in three
tests (`"false"`, `""`, deleted) rather than described in a comment.

Ruling (F1): the signed payload becomes `JSON.stringify([...])`. `a|b|c` was ambiguous —
measured, not argued: `sign("A|B","C",1) === sign("A","B|C",1)` returned true. It did not leak
because both fields are server UUIDs and a UUID holds no pipe, but that is a property of
today's CALLERS, not of the scheme, and this issue adds a second server-chosen field and
invites a third. If wrong: every token in flight is invalidated at deploy — a visitor-facing
logout, which is why a positive control asserts an ordinary token still verifies.

Ruling (F2): expiry is bounded in BOTH directions — `issuedAt > now + CLOCK_SKEW_MS` →
`malformed`. `now - stamp > TTL` alone meant a future stamp was never old and so never expired;
a token stamped a year ahead verified clean for a year. Skew is 5 minutes rather than zero
because servers behind a load balancer disagree by seconds, and refusing every future stamp
would log visitors out intermittently and unreproducibly. Reported as `malformed` rather than
`expired` because that is what it is: a stamp this server could not have issued.

Ruling: `Number.isSafeInteger` joins `/^\d+$/` on both stamps — AND IS REDUNDANT TODAY. The
pattern already rejects `"1e999"`, but not `"9"` repeated four hundred times, which is
digits-only and becomes `Infinity`. Mutation showed removing the guard leaves the suite green,
because the clock-skew bound already refuses Infinity. Kept as defence in depth against one
foreseeable edit — moving or loosening that bound would silently restore the immortal-token bug
— and documented as redundant IN THE SOURCE rather than defended with a contrived test that
would assert an implementation detail instead of a behaviour.

Ruling: no new UUID validation was added, because the requested check already exists and a
second would be dead code. Verified rather than assumed: the mint route accepts NO session id
at all (nothing to validate), `embedMiddleware.js:113` validates for stream-chat, and `:279`
for the history routes. F1 is closed by the payload encoding, not by the id format.

Ruling: every token minted before this change is invalid at deploy, with NO dual-verify path.
Accepting the legacy `a|b|c` payload alongside the new one would keep the F1 collision alive
for the length of the compatibility window, which defeats the fix. `EMBED_REQUIRE_SESSION_TOKEN`
is off on every deployment we control, so today's blast radius is zero. A deployment running
with it ON must flip it off before deploying and back on after — recorded in the module header
as a deploy note, because that ordering is not discoverable from the diff.

Ruling: the constant-time comparison is pinned by asserting the SOURCE contains
`crypto.timingSafeEqual`, not by measuring timing. A real timing measurement is flaky on shared
CI and proves nothing on a fast machine — it would fail randomly and pass for the wrong reason.
Mutation-verified: swapping in `===` fails it.

Ruling: the mint endpoint gets its own gate, `embedSessionOpen`, rather than reusing
`canRespond` or `embedHistoryAccess`. Both read a session id that does not exist yet at session
open, and `embedHistoryAccess` would additionally put an `embed_chats` read back on the one path
that must not have one (hole 3). It keeps what applies before a session exists: the embed must
be enabled, and the origin must be allowed.

Ruling: `POST /embed/:embedId/session` is declared in the #52 route-gate sweep's
`INTENTIONAL_NON_PERMISSION_MUTATIONS` with a written reason, and the pinned route count moves
316 → 317. It is unauthenticated by nature — a site visitor has no identity until this endpoint
gives them one, so there is no principal for the engine to decide about — but not ungoverned:
`embedSessionOpen` enforces enabled + origin, `embedHistoryRateLimit` bounds it per caller, and
it persists nothing.

## Corrections — things I got wrong, and how they were caught

Correction 1 (found by MUTATION, not review): removing `embedSessionOpen` from the route
entirely left my suite GREEN. Nothing was asserting the mint endpoint's origin or enabled gate,
so an embed that restricts its origins would have had one unguarded way in, handing out tokens
valid on the guarded routes. Two tests added; that mutant is red now. This is the finding I
would point a reviewer at first, because the gap was in MY tests, not in someone else's code.

Correction 2 (found by the #52 sweep): my new route is a mutating POST with no permission
middleware, and I had run that sweep green earlier only because environment failures were
masking it in the full run. The sweep did exactly its job. Resolved by declaring the exemption
above rather than by weakening the sweep.

Correction 3 (peer was right, I was wrong): I claimed a cross-IP rate-limit test could not be
staged, because `canonicalIp` reads `socket.remoteAddress` and supertest dials the loopback.
The peer pointed out a middleware mounted ahead of the limiter can overwrite it. Measured:
`200 / 429 / 200`. My "cannot be simulated" comment is deleted and the test restored, using two
IPv4 addresses — NOT two IPv6 in one /64, which `canonicalIp` deliberately collapses into one
bucket, so a v6 pair would have asserted the opposite of the intended design while looking like
a stronger test. Added an assertion nobody asked for: the first IP returns after the second is
served and is still 429 — without it, one shared bucket that happened to reset would produce
the same 200/429/200 and the test could not tell the difference.

Correction 4: two #32 oracle tests asserted the contract this issue inverts. Rewritten rather
than deleted, with the reason inline, and an `updated` comment posted on #49 before the SHA. A
deleted test leaves no trace that a contract moved.

## Residuals

- **A leaked token cannot be revoked** before it expires (no session table). Now bounded at 7
  days rather than indefinitely, but still not revocable on demand — its own issue if wanted.
- **The rate-limit key is the IP alone**, so one caller's budget spans every embed it touches.
  Self-inflicted rather than cross-tenant — the key IS the caller, so it cannot throttle anyone
  else — but real, and asserted so that making it per-(ip, embed) later is a visible decision
  rather than an accident.
- **All existing tokens are invalidated at deploy.** Harmless while the flag is off, which it is
  everywhere we control; a deployment with it ON must flip it off first.
- **The widget still mints its own id** until V7-widget ships; `EMBED_REQUIRE_SESSION_TOKEN`
  must stay OFF until then.

## Environment notes (not code)

Three "failures" during this issue were environment, and each cost time worth not re-spending:
`nodemailer` (8 suites) and `prom-client` (2 suites) were declared in `package.json` but absent
from `node_modules` after the rebase, and the generated Prisma client was stale (`invites.email`
in the schema, not in the client). After every rebase onto `approof/main`: `yarn install` and
`prisma generate` BEFORE judging any red.

Separately filed: **#106**, `requestControlsHttp` returned 501 once under a full `--runInBand`
run. Not #49 — reproduces on the base tree with this work stashed — and not the limiter, whose
refusal is 429; nothing in `requestControls.js` or `express-rate-limit` emits 501, so some other
handler answered. Did not reproduce in four isolation attempts. Linked from #97.
