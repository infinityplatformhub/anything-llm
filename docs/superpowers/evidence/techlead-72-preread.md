# Techlead-1 — #72 pre-read (working tree `.claude/worktrees/pr72`, before Dev1's SHA)

Read at `b3ccb510` plus the uncommitted work: `systemSettings.js`, four route files,
`outlookAgentUtils.js`, `outlook/lib.js`, two new test files. Read-only.

**Every ruling in the recon is implemented, and the shapes are right.** Two observations to reach Dev1
before the SHA, one of which is a real coverage gap in the test table.

## The rulings, checked

**Typed `code`, not error-string parsing.** `updateSettings` returns
`{success:false, error, code:"unknown_keys", unknownKeys}`. All five surfaces branch on
`result.code === "unknown_keys"`, none on the message. I ran the status logic against three mutants:

| result | real logic | mutant: parse `error` string | mutant: no `code` branch |
|---|---|---|---|
| `code:"unknown_keys"` | **400** | 400 | 500 |
| write failure, plain message | 500 | 500 | 500 |
| **write failure whose message contains "unknown"** | **500** | **400** ✗ | 500 |
| success | 200 | 200 | 200 |

The third row is why the ruling is right and it is not hypothetical: a Postgres error like
`column unknown in table` would be reclassified as a client error by the string-parsing version.
The `code` branch cannot be fooled by message text.

**All-or-nothing, and no input mutation.** The `delete updates[key]` loop is gone; the model now
collects unknown keys *before* filtering and passes `{...updates}` to `_updateSettings`. Simulated the
new function in isolation: a mixed body returns `unknown_keys` with `_updateSettings` never called,
and the caller's object is byte-identical afterwards. The model test asserts both
(`expect(write).not.toHaveBeenCalled()` and `expect(updates).toEqual(original)`), which is the pair
that matters — asserting only the return value would pass while the write still happened.

**Swagger breaking note** is on `/v1/admin/preferences` and names the three read-only keys. I verified
the asymmetry is real by executing the model: `publicFields` 26, `supportedFields` 28,
readable-but-not-writable = `max_embed_chunk_size`, `imported_agent_skills`, `feature_flags` — exactly
the three named. The read-modify-write round trip the recon warns about is the right thing to call
out.

**Outlook persist** — `exchangeCodeForToken` and the refresh path both `return persisted` when the
write fails instead of proceeding to set `this.#accessToken`, and `outlookAgentUtils.js:70` now checks
before `reset()`. That closes my #70 NIT-2 in this PR rather than deferring it.

## FINDING-1 (for Dev1, before the SHA) — the route table proves the mapping with a *mock*, so only one route's real model path is covered

`routes` has four entries and two `test.each` blocks over it, but both mock
`SystemSettings.updateSettings` (or `_updateSettings`) to return a canned result. They prove *the
route maps a typed result to a status* — worth having — but not that the route reaches a real
unknown-key refusal.

The three unmocked, end-to-end tests (`mixed keys answer 400 and write no valid key`,
`all-unknown body answers 400`, `all-valid body answers 200 and writes the setting`) all target
**`/api/admin/system-preferences` only**. So for `/v1/admin/preferences` — the route with the swagger
breaking note, the one external integrations call — nothing drives a genuine unknown key through the
real model to the real database.

That matters because the two routes are not the same code path: the `/v1` route is behind
`validApiKey` with `system.write` scope, and a body-shape or middleware difference would be invisible
to a mocked test. The mixed-body case is also the ruling's stated heart, and it is asserted on one
route.

Cheapest fix: parameterise the three unmocked tests over the first two `routes` entries (admin + v1).
Community-hub and default-system-prompt genuinely cannot take an arbitrary unknown key from a caller
in the same way — hub takes `hub_api_key`, the prompt route builds its own object — so mock-only is
defensible for those two; admin and v1 both take a free-form body and should both be driven for real.

## FINDING-2 (minor, worth a decision rather than a change) — `/community-hub/settings` now returns 400 on a body the frontend cannot send, and 500 changed shape

`communityHub.js` passes `reqBody(request)` straight through, so it inherits the refusal. Checked the
only frontend caller: `CommunityHub.updateSettings` is invoked at
`GeneralSettings/CommunityHub/Authentication/index.jsx:33,52` with `{hub_api_key: …}` and
`{hub_api_key: ""}`. `hub_api_key` is in `supportedFields` — verified — so no frontend path can 400.
Good.

But the success response changed from `{success: true, error: null}` to `response.status(200).json(result)`,
and `result` for a successful write is whatever `_updateSettings` returns. The frontend only reads
`res.ok` and `response.error`, so nothing breaks today. Flagging because the recon's surface table
describes the community-hub change as a status split, and the body shape moved too — worth one line in
the ledger so it is a decision rather than a side effect.

## Two things I could not fault

- The `all-valid body answers 200 and writes the setting` positive control is present and reads the
  row back from the database. Without it a route hard-wired to 400 would pass every refusal test.
- `default system prompt exposes the model error as its HTTP message` pins the `error` vs
  `error.message` fix from #70 at the HTTP layer rather than by reading source, which is a strict
  improvement on the source-text assertion #70 shipped.

## What I did not do
Did not run the suite (§7.14). The mutant table and the field-asymmetry numbers come from executing
the real model and the route status logic under node 22. Read-only in that worktree.
