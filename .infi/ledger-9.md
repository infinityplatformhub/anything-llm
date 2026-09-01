# Ledger — issue #9 · P0-4 PR-1 key generator ≥256-bit entropy (R7)

Branch: `approof/p0-4-pr1-key-entropy` · Worktree: `.claude/worktrees/p0-4-pr1`
Date: 2026-09-02 · Owner: Dev 3/4

## What

Replace `uuid-apikey` (Base32 of UUIDv4 — 122 bits) with
`crypto.randomBytes(32).toString("base64url")` — 256 bits — in three generators:

- `ApiKey.makeSecret` → `sk-<43 base64url chars>`
- `BrowserExtensionApiKey.makeSecret` → `brx-<43>` (prefix kept; R11 recon showed
  server-side `startsWith("brx-")` at browserExtensionApiKey.js:41 is the only
  format check — extension treats key as opaque)
- `TemporaryAuthToken.makeTempToken` → `allm-tat-<43>`

## Rulings

- **Ruling:** `makeTempToken` included though the issue named only the two key
  models — same 122-bit weakness, same one-line fix, and these tokens mint session
  JWTs (recon F-4); leaving it weak would undercut PR-0. Flagged to PMO.
- **Ruling:** Prefix added to ApiKey secrets (had none). PR-3 needs a stable
  prefix for `keyPrefix` UI display; adding it now avoids a second format change.
  Old format had no prefix so no collision. Keys still stored/compared verbatim —
  no auth behavior change until PR-3.
- **Ruling (e5 review):** Prefix is `apw-`, not the initially chosen `sk-` — this
  repo already validates OpenAI keys by their `sk-` prefix (updateENV.js:1066 plus
  frontend placeholders), so reusing it for a different credential type invites
  confusion once PR-3 shows keyPrefix in the UI. `apw-` = ApproofWorkspace.
- **Ruling:** `models/invite.js:6` also uses uuid-apikey (invite codes) — **left
  unchanged**: out of #9 scope, invite codes are short-lived single-use, not bearer
  credentials. PMO can open a follow-up if wanted.
- **Ruling:** `uuid-apikey` dependency NOT removed from package.json — invite.js
  still consumes it.

## Files

- `server/models/apiKeys.js`, `server/models/browserExtensionApiKey.js`,
  `server/models/temporaryAuthToken.js` (generator bodies only)
- `server/__tests__/models/keyGeneratorEntropy.test.js` (new, 10 tests)

## Evidence

```
cd server && npx jest → Tests: 627 passed (617 baseline + 10 new)
```

Initial RED: 6 failed / 4 passed (all three generators failed format + randomBytes
assertions).

### RED proofs (3 mutations on ApiKey.makeSecret, restored after each)

1. **Revert to uuid-apikey** → 2 failed (format + randomBytes-source).
2. **`randomBytes(16)`** (128 bits) → 2 failed (length 22≠43 + called-with-32).
3. **`Math.random()`-derived 43-char base64url** (right shape, wrong source) → 1
   failed (randomBytes spy) — proves the source assertion catches a format-
   mimicking downgrade.

Restored: 10/10 green, full suite 627/627.
