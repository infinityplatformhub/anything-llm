# Ledger — issue #12 · PR-0d embed history IDOR (G12)

Branch: `approof/pr0d-embed-idor` · Worktree: `.claude/worktrees/pr0d`
Date: 2026-09-02 · Owner: Dev 3/4

## What

`GET /embed/:embedId/:sessionId` (read history) and `DELETE` (invalidate history)
at endpoints/embed/index.js:70/93 carried only `validEmbedConfig` — which just
resolves the embed by public uuid. Unlike the chat path (`canRespond`), they
enforced no enabled flag, no origin allowlist, and no sessionId format check.
embedId is public by design (it ships in the widget snippet), so anyone could
read or invalidate any session's chat history cross-origin given a sessionId.

New `embedHistoryAccess` middleware (after `validEmbedConfig` on both routes):
1. sessionId must be a UUID (404 otherwise) — same check canRespond does for chat.
2. embed must be enabled (503) — same as chat.
3. Origin must satisfy the embed's allowlist when one is configured (401) —
   same rule as chat: `parseAllowedHosts` null = allow-all.

## Rulings

- **Ruling:** Reused canRespond's exact gate semantics (including null-allowlist =
  allow-all and the `EMBED_REQUIRE_ALLOWLIST` behavior being chat-only) rather than
  inventing stricter rules — PR-0 hotfixes match existing policy, they don't set
  new policy. Tightening allowlist defaults is a separate decision.
- **Ruling:** sessionId stays unauthenticated-but-unguessable (UUID as bearer):
  fixing that needs a session token scheme = schema change, out of hotfix scope
  (banned by PMO constraint). UUID format check kills trivial enumeration
  (`sessionId=1`); rate limiting in #6 adds the second layer. `ponytail:` ceiling
  noted: real fix is embed session tokens, post-P0-5.
- **Ruling:** Error bodies are minimal `{error}` JSON, not the chat-shaped abort
  envelope — these are REST reads, not stream chunks.

## Files

- `server/utils/middleware/embedMiddleware.js` (new middleware + export)
- `server/endpoints/embed/index.js` (both routes: `[validEmbedConfig, embedHistoryAccess]`)
- `server/__tests__/utils/middleware/embedHistoryAccess.test.js` (new, 6 tests)

## Evidence

```
cd server && npx jest → Tests: 623 passed (617 baseline + 6 new)
```

Initial RED: `TypeError: embedHistoryAccess is not a function`.

### RED proofs (3 mutations, restored after each)

1. **enabled check → `if (false)`** → 1 failed (disabled-embed test).
2. **allowlist check → `if (false)`** → 1 failed (evil-origin test).
3. **middleware removed from both route arrays** → 1 failed (wiring test asserts
   exactly 2 `[validEmbedConfig, embedHistoryAccess]` occurrences).

Final: 6/6 green, full suite 623/623.
