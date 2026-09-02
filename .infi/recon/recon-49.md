# #49 recon — embed session: server-minted sessionId + token

Read-only. Base `88a1682ae`, branch `approof/49-embed-session`.

Closes the four residual holes #32 left, all recorded verbatim in `residual-risks.md`.

---

## The root cause, in one line

**The session id is chosen by the client.** Every hole below is a consequence of that, which
is why patching the mint rule again cannot close them: any rule of the form "mint for free
in *some* case" leaves the case open, and #32's rule already is the narrowest one that keeps
a first message working.

Today (`endpoints/embed/index.js:60`): the widget mints a v4 UUID into localStorage, sends
it in the `stream-chat` body, and `mintIfEntitled` decides whether it has earned a token.

## The four holes, verified against the code

**Hole 1 — the pre-first-message window.** `mintIfEntitled` (`embedSessionToken.js:139`)
treats "no `embed_chats` row for (embed, session)" as *new*. The row is written by
`EmbedChats.new` only after the LLM has replied (`utils/chats/embed.js`), so between the
victim's first request and their first stored reply — seconds, sometimes longer on a slow
model — an attacker naming that same id is also "new" and gets a valid token.

**Hole 2 — concurrent first requests.** `embed_chats` has **no unique constraint** on
`(embed_id, session_id)` (schema.prisma:287-299) and `mintIfEntitled` does its
read-then-mint outside a transaction. Two requests naming the same fresh id both read "no
row" and both mint. The `@@unique` needed to make this a database-level race rather than an
application one does not exist.

**Hole 3 — emptying the rows re-opens minting.** `DELETE /embed/:embedId/:sessionId` calls
`markHistoryInvalid`, which sets `include: false` and leaves the rows — so that path does
NOT re-open minting, and the residual overstates it slightly. But the embed cascade does:
`embed_chats.embed_id` is `onDelete: Cascade` (schema.prisma:297), so deleting and
recreating an embed empties them for real. Any future hard-delete of chats has the same
effect. The rule is only as durable as the rows it reads, and rows are not the right place
to record "this session has an owner".

**Hole 4 — mint-vs-verify is an oracle.** A response carrying
`x-allm-session-token` means "new session"; its absence means "exists and you did not prove
you own it". #32 deliberately kept the chat working in both cases to avoid a 4xx oracle —
but the header's presence is the same signal in a quieter form.

## The shape that closes all four

A session id the server generates, at a session-open endpoint, minted together with its
token:

```
POST /embed/:embedId/session   ->  { sessionId, token }
```

- Hole 1 dies: entitlement no longer depends on whether a row exists yet.
- Hole 2 dies: the server generates the id, so two callers cannot name the same one.
- Hole 3 dies: entitlement is not derived from `embed_chats` at all.
- Hole 4 dies: every caller of the open endpoint gets exactly one response shape; there is
  nothing to compare.

`stream-chat` and the history routes then require a verified token **unconditionally** —
no "mint if entitled" branch survives, because that branch IS the hole.

## Open questions for a ruling

1. **Does the session need a table?** A signed token is self-contained
   (`HMAC(SIG_KEY, embedUuid|sessionId|issuedAt)`) and needs no row, which keeps the change
   small and avoids a write on every session open. But without a row there is no
   revocation: a leaked token stays valid for its 24h TTL. **Recommendation: no table for
   this issue** — the token already carries a TTL, and adding revocation is a bigger change
   that should be its own issue if wanted.
2. **What does the flag govern once this lands?** `EMBED_REQUIRE_SESSION_TOKEN` is
   presence-based and currently gates *enforcement on the history routes* only. After this,
   enforcement is meant to be unconditional — so the flag either disappears or comes to mean
   "reject requests without a token on stream-chat too". These are different things and the
   issue title says "unconditionally", which reads as the flag going away. **Needs a
   ruling**, because removing it changes behaviour for any deployment running the widget
   that has not shipped yet.
3. **The widget half may not be ours.** `.gitmodules` points `embed/` at
   `Mintplex-Labs/anythingllm-embed`, upstream, and the submodule is **not checked out** in
   this worktree (`git submodule status` shows `-7e5c6afc`). The issue says the widget must
   call the open endpoint and echo the token, but I cannot change an upstream repository we
   do not control. **Needs a ruling**: fork it, vendor the hook, or ship the server side
   behind the flag and leave the widget to a follow-up. This determines whether "stops using
   client v4()" is in scope at all.
4. **Backward compatibility.** Sessions already in `embed_chats` were client-minted. After
   this, do existing visitors lose their history (their id was never server-issued), or does
   an id that already has rows keep working? Losing it is the clean answer and a visible
   regression; keeping it re-opens hole 3 in a new form. **Needs a ruling.**

## PMO rulings (answers to the four above)

Ruling 1: NO session table in this issue. The token is self-contained —
`HMAC(SIG_KEY, embedUuid|sessionId|issuedAt)` with a 24h TTL — so a session costs no write
and no row to keep consistent. The cost is that a leaked token cannot be revoked before it
expires; that is a separate issue, recorded as a residual rather than left implicit.

Ruling 2: `EMBED_REQUIRE_SESSION_TOKEN` STAYS, and keeps its current meaning — it gates
enforcement on the history routes only. What becomes unconditional is the MINT endpoint:
`POST /embed/:embedId/session` always exists and always server-mints. Those are different
things, and the issue title conflated them; the title is being corrected rather than the
behaviour bent to match it. Removing the flag would change behaviour for every deployment
whose widget has not shipped.

Ruling 3: the WIDGET IS OUT OF SCOPE. `.gitmodules` points `embed/` at
`Mintplex-Labs/anythingllm-embed` — upstream, which we do not control, and it is not even
checked out here. This issue delivers the complete server side: the mint endpoint, and
history routes that accept only a server-minted id (verified by its HMAC) when the flag is
on. Forking or vendoring the widget is its own issue (V7-widget). So "widget stops using
client v4()" is NOT part of this change, and the issue title is corrected accordingly.

Ruling 4: an existing client-minted session is REFUSED once the flag is on, and behaves
exactly as today while it is off. Refusing is a visible regression; the alternative —
honouring ids that were never server-issued — re-opens hole 3 in a new shape, and a silent
hole is worse than a visible logout. The migration path is therefore: ship the server,
ship the widget, then turn the flag on. Recorded as a residual so the ordering is not
rediscovered by whoever flips it.

Ruling (WITHDRAWN, and the correction matters): there is NO unique constraint and NO
migration. I proposed `@@unique([embed_id, session_id])` on `embed_chats` and was wrong —
that table stores one row PER MESSAGE, not per session (`EmbedChats.new`,
`models/embedChats.js:16-32`, creates a row for every prompt/response pair). The constraint
would fail the migration outright on any deployment holding real data, and on an empty one
it would silently reject the second message of every conversation. Embed chat would break.

The right fix is smaller: hole 2 is a race to CLAIM AN ID, and once the server mints the id
with `crypto.randomUUID()` no caller chooses one, so there is nothing to race for. Hole 2 is
a consequence of the client-chosen id exactly like the other three — remove the root cause
and it goes with them. No database change is needed.

Ruling: the mint endpoint must REFUSE an id supplied in the body or query. That is the one
way hole 2 comes back — an endpoint that accepts a caller's id is a client-chosen id wearing
a server-minted name — so it is asserted rather than assumed.

## Rulings taken during implementation

Ruling: `mintIfEntitled` KEEPS rotation and loses only the free-mint branch — because rotation
opens no new hole (it demands a valid token for the very session it refreshes, which is the
proof the whole scheme rests on), and without it an ongoing conversation is logged out at the
24h TTL mid-thread. If this is wrong, the cost is that a STOLEN token can be renewed
indefinitely: rotation binds no absolute maximum lifetime, so a leaked token's 24h ceiling
becomes a rolling window rather than a deadline. Recorded as a residual; an absolute cap is
its own issue if wanted.

Ruling: `EMBED_REQUIRE_SESSION_TOKEN` stays presence-based (`"KEY" in process.env`), so
`=false` and `=` both ENABLE it. Because the failure directions are not symmetric: under
boolean parsing a typo (`=ture`, `=0`, `=off`) silently DISABLES a gate the operator believes
is on and nothing anywhere says so, while presence-based the worst case is an unexpected 401 —
visible within minutes. Same convention as `EMBED_REQUIRE_ALLOWLIST` beside it. If this is
wrong, an operator who writes `=false` meaning "off" gets "on", which is a support ticket
rather than a breach. Now asserted in three tests rather than described in a comment.

Ruling (F1, from QA-1 pre-read): the signed payload becomes
`JSON.stringify([embedUuid, sessionId, issuedAt])`. `a|b|c` was ambiguous — measured, not
argued: `sign("A|B","C",1) === sign("A","B|C",1)`. It did not leak because both fields are
server UUIDs and a UUID holds no pipe, but that is a property of today's CALLERS, not of the
scheme, and #49 adds a second server-chosen field and invites a third. If this is wrong, every
token in flight is invalidated at deploy — a visitor-facing logout, which is why a positive
control asserts an ordinary token still verifies.

Ruling (F2, same source): expiry is bounded in BOTH directions, `issuedAt > now + 5min` →
`malformed`. `now - stamp > TTL` alone meant a future stamp was never old and so never
expired; a token stamped a year ahead verified clean for a year. Skew is 5 minutes rather than
zero because servers behind a load balancer disagree by seconds, and refusing every future
stamp would log visitors out intermittently and unreproducibly. If this is wrong in the other
direction, a clock skewed further than 5 minutes rejects its own tokens — visible immediately.

Ruling: the mint endpoint gets its own gate, `embedSessionOpen`, rather than reusing
`canRespond` or `embedHistoryAccess`. Both read a session id that does not exist yet at
session open, and `embedHistoryAccess` would additionally put an `embed_chats` read back on
the one path that must not have one (hole 3). It keeps what applies before a session exists:
the embed must be enabled, and the origin must be allowed. Found necessary by MUTATION —
deleting the gate entirely left the suite green, so nothing was asserting it.

Ruling (TL-2 1): a session gets an ABSOLUTE ceiling of 7 days. `firstIssuedAt` is a fourth
element in the signed payload; rotation carries the original through unchanged, and
verification refuses once `now - firstIssuedAt > 7d` (reported as `expired`, the same as the
TTL — telling them apart would say how long ago the session opened). Without it, rotation
renews forever and the 24h TTL is a rolling window rather than a deadline, which is exactly
the residual the rotation ruling above created. If this is wrong, a conversation genuinely
spanning more than a week starts a new session — visible and recoverable, unlike an unbounded
stolen credential. Mutation-verified twice: restarting `firstIssuedAt` on rotation fails one
test, removing the ceiling fails a different one.

Ruling (TL-2 2): `/^\d+$/` stays on BOTH stamps, and `Number.isSafeInteger` joins it.
Measured: the pattern already rejects `"1e999"`, but NOT `"9"` repeated four hundred times —
digits-only, and `Number()` of it is `Infinity`, which is never more than a TTL in the past.
Honest correction: mutation showed the `isSafeInteger` line is REDUNDANT today, because the
clock-skew bound already refuses Infinity. It is kept as defence in depth against a specific
foreseeable edit (moving or loosening that bound) and documented as redundant in the source,
rather than defended with a contrived test that would assert an implementation detail.

Ruling (TL-2 3): no new UUID check was added, because the requested one already exists and a
second would be dead code. Verified rather than assumed: the mint route accepts NO session id
at all (nothing to validate), and both consuming routes validate it —
`embedMiddleware.js:113` for stream-chat and `:279` for the history routes. F1 is closed by
the payload encoding, not by the id format, so this is belt-and-braces that was already
buckled. Asserted at the route instead of duplicated in code.

Ruling (TL-2 4): every token minted before this change becomes invalid at deploy, and there
is NO dual-verify path. Accepting a legacy `a|b|c` payload alongside the new one would keep
the F1 collision alive for as long as the compatibility window lasted, which defeats the fix.
`EMBED_REQUIRE_SESSION_TOKEN` is off on every deployment we control, so the blast radius today
is zero; the release note must say that a deployment running with it ON should flip it off
before deploying and back on after. Recorded here because that ordering is not discoverable
from the diff.

Ruling (TL-2 6): the constant-time comparison is pinned by asserting the SOURCE contains
`crypto.timingSafeEqual`, not by measuring timing. A real timing measurement is flaky on
shared CI and proves nothing on a fast machine, so it would be a test that fails randomly and
passes for the wrong reason. Mutation-verified: swapping in `===` fails it.

## Residuals this leaves open

- ~~Rotation binds no maximum lifetime.~~ CLOSED in this issue by TL-2 ruling 1: a 7-day
  absolute ceiling counted from `firstIssuedAt`, which rotation carries rather than resets.
- **All existing tokens are invalidated at deploy** (TL-2 ruling 4). Harmless while
  `EMBED_REQUIRE_SESSION_TOKEN` is off, which it is everywhere we control; a deployment with
  it ON must flip it off before deploying.
- **A leaked token cannot be revoked** before its TTL (no session table, Ruling 1).
- **The rate-limit key is the IP alone**, so one caller's budget spans every embed it touches.
  Self-inflicted rather than cross-tenant — the key IS the caller, so it cannot be used to
  throttle anyone else — but real, and asserted so making it per-(ip, embed) later is a
  visible decision rather than an accident.
- **The widget still mints its own id** until V7-widget ships; `EMBED_REQUIRE_SESSION_TOKEN`
  must stay OFF on every deployment until then.

## Tests (RED first)

- **Hole 1**: request a token for a session id whose victim has requested but not yet
  received a reply → refused. RED on today's code.
- **Hole 2**: two concurrent opens produce DIFFERENT ids, and the endpoint refuses an id
  passed in the body or query — the only way a caller could reintroduce the race.
- **Hole 3**: emptying `embed_chats` for a session does not make it mintable again.
- **Hole 4**: two calls to the open endpoint are byte-identical in shape — same status,
  same keys — regardless of what the caller knows. Compared as raw bodies, per the S-25
  lesson: comparing parsed fields lets a stray key through.
- **Unconditional enforcement**: `stream-chat` without a token is refused, and the refusal
  is indistinguishable from one with a token for a session that does not exist.
- The two #32 gaps that never got tests: NIT-3 (`embed_id` scoping in `mintIfEntitled` —
  dropping it is a cross-tenant mint DoS) and NIT-4 (`embedHistoryRateLimit` wiring on
  `stream-chat`).

## Size

Server side ~150 lines plus the endpoint, 15-20 tests. The widget is unsized until question
3 is answered.
