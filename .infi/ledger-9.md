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
- **Ruling (e5 round 2, supersedes earlier prefix rulings):** Final credential
  prefixes — `apw-key-` (API), `apw-tat-` (temp token), `apw-brx-` (browser
  extension), `apw-inv-` (invite). Bare `apw-` was dropped: it can't be parsed
  by type without checking every longer prefix first; PR-3 routes by prefix, so
  the type suffix is symmetric from day one. `browserExtensionApiKey.js:41`
  `startsWith` updated with the generator.
- **Ruling (Techlead F1):** `models/invite.js` generator replaced in THIS PR —
  an invite code redeems a real account, so it is a bearer credential under the
  R6/R7 floor like everything else. `uuid-apikey` removed from package.json and
  yarn.lock in the same commit: this PR was its last consumer, and leaving it
  installed would make R6 look closed while the hole remained.

## Release note (for PMO)

> New secrets generated after this release use `apw-key-`, `apw-brx-`,
> `apw-tat-`, and `apw-inv-` prefixes with 256-bit entropy. **Existing
> browser-extension keys with the old `brx-` prefix stop validating
> immediately** — operators must reissue them (the extension treats the key as
> an opaque string; only paste needed). Pre-existing API keys and invite codes
> keep working until the API-key migration force-rotates them (PR-3).
- **Ruling (QA-2/PMO):** temp-token prefix `allm-tat-` → `apw-tat-` — old brand
  string survived P0-7's de-brand; caught in QA-2 pass.
- **Scope-out (explicit, per PMO):**
  1. `models/invite.js:6-7` still generates invite codes via uuid-apikey
     (122-bit) — PMO opens a separate follow-up; not bearer credentials.
  2. **Dual-format window:** pre-existing keys (uuid-apikey format, plaintext)
     still authenticate until the PR-A/PR-3 migration force-rotates them. This PR
     changes only what NEW keys look like.
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
