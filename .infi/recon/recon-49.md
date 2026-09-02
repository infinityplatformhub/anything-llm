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

Ruling: a `@@unique([embed_id, session_id])` migration lands with this issue. Hole 2 is a
race, and application-level check-then-act cannot close a race — only the database can
refuse the second writer. The slot is declared on the issue.

## Tests (RED first)

- **Hole 1**: request a token for a session id whose victim has requested but not yet
  received a reply → refused. RED on today's code.
- **Hole 2**: two concurrent opens cannot produce the same id (and, if a table lands, the
  unique constraint is asserted at the database, not only in application code).
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
