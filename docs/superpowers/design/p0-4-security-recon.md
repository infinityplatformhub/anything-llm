# P0-4 Security hardening — recon note + implementation plan

Status: **recon complete, PMO rulings applied, awaiting #4/#5 merge before any code is written.**
Baseline: `cd server && yarn install --frozen-lockfile && yarn test` → **617/617 green, 45 suites**. (`server/node_modules` was absent on a clean checkout; the install step is required before the suite runs at all.)

## PMO rulings (binding, 2026-09-02)

| # | Ruling |
|---|---|
| R1 | P0-4 starts only after **P0-2 (Postgres) and P0-6 (queue/bus) merge**. Migrations are written against real Postgres; no SQLite-then-rebase. |
| R2 | F-6 scope is narrowed — see §3 Step 6. Provider-secret migration out of `.env` is a **separate later task**; P0-4 must not claim system-wide secret encryption. |
| R3 | Scope strings are seam 02 action names verbatim (`workspace.write`, `document.read`). No second mapping layer for P0-5 to unwind. |
| R4 | Key-identity audit publishes through the **P0-6 event bus only**. No interim `EventLogs.logEvent` call that has to be migrated twice. |
| R5 | Simple SSO impersonation (F-4) and `browser_extension_api_keys` plaintext (F-7) are **in mandatory scope**, not stretch. |
| R6 | Key digest is **HMAC-SHA-256(secret, `API_KEY_PEPPER`)**, not argon2/bcrypt — API keys are high-entropy random, and the middleware needs a deterministic O(1) lookup; a password KDF would add native build cost and force a full-table scan. Store `keyPrefix` for UI, compare digests in constant time, keep the pepper in env separate from the DB, and document that rotating the pepper rotates every key. If key generation entropy is below 256 bits, fix the generator first. |

## 1. Audit findings (verified against code)

### F-1 — API keys stored plaintext, no scope, no expiry (CRITICAL)
- `server/prisma/schema.prisma:18-26` — `api_keys` holds only `id, name, secret (unique), createdBy, createdAt, lastUpdatedAt`. `secret` is the raw bearer token.
- `server/models/apiKeys.js:7-10` — `makeSecret()` = `uuid-apikey`; stored verbatim at `:19`.
- Any DB read (backup, dump, SQLi, ops access) is full API takeover. Seam 08 already assumes scoped keys (`scopedKeyId`, `embed-key` budget scope) that do not exist yet.

### F-2 — `validApiKey` is god-mode (CRITICAL)
- `server/utils/middleware/validApiKey.js:17` — the whole check is `ApiKey.get({ secret: bearerKey })` truthy → `next()`.
- No scope check, no per-route action, no identity on `response.locals`, no `lastUsedAt`, no record of which key acted.
- **62 guarded route references across 9 endpoint files** — every one treats any valid key as full admin:

| file | refs |
|---|---|
| `api/admin/index.js` | 13 |
| `api/document/index.js` | 13 |
| `api/workspace/index.js` | 11 |
| `api/embed/index.js` | 6 |
| `api/workspaceThread/index.js` | 6 |
| `api/openai/index.js` | 5 |
| `api/system/index.js` | 5 |
| `api/userManagement/index.js` | 2 |
| `api/auth/index.js` | 1 |

(An earlier draft of this note said "30 across 5 files" — that came from a truncated grep and was wrong. The count above is the full sweep; verify with the command in §6.)
- Violates seam 02's "MUST NOT grant global bypass"; today the `/v1` surface has no engine at all.

### F-3 — no rate limiting anywhere (HIGH)
- No `express-rate-limit` or equivalent anywhere in `server/`; dependency absent.
- `POST /request-token` (`server/endpoints/system.js:198`) runs `bcrypt.compareSync` per attempt and answers **HTTP 200** with `valid:false` on bad credentials (`:227`, `:245`). Unlimited online brute force, and the 200 makes it trivial to script.
- Failed attempts already emit `failed_login_invalid_username` / `_invalid_password` / `_account_suspended`, so lockout has a signal to build on — nothing consumes it.

### F-4 — Simple SSO issuance open to every key (HIGH, mandatory per R5)
- `GET /v1/users/:id/issue-auth-token` (`server/endpoints/api/userManagement/index.js:67`) is guarded by `[validApiKey, simpleSSOEnabled]`.
- `simpleSSOEnabled` (`server/utils/middleware/simpleSSOEnabled.js:11-34`) checks only the `SIMPLE_SSO_ENABLED` env var and multi-user mode — **it never inspects which key called**.
- Chain: any API key → temp token for **any userId including an admin** → `GET /request-token/sso/simple` (`system.js:351`) → real session JWT. Key-to-full-impersonation, not merely god-mode.
- `TemporaryAuthToken.expiry = 1000 * 60 * 6` (`server/models/temporaryAuthToken.js:10`) is **6 minutes**; the adjacent comment says "1 hour". The value is fine, the comment is wrong — fix the comment, keep the value.

### F-5 — no IP/CIDR allowlist (MEDIUM)
Nothing exists. Plan step 4 wants it per-deployment, default off.

### F-6 — secret handling (MEDIUM, scope set by R2)
- `EncryptionManager` (`server/utils/EncryptionManager/index.js`) works (aes-256-cbc, scrypt from `SIG_KEY`/`SIG_SALT`) but is used only for JWT `p` payloads in single-user mode.
- Provider/LLM/connector secrets live in the ENV file via `updateENV.js` / `dumpENV()` (`server/utils/helpers/updateENV.js:1473`) — **not** in a DB column. The plan's original "encrypt credentials in DB" wording does not match reality; the exposure is a file on disk.
- `EncryptionManager` self-assigns a key and `dumpENV()`s it when absent (`index.js:38-42`). An air-gapped deployment must be handed a stable `SIG_KEY`, or a regenerated file silently invalidates every previously encrypted value.

### F-7 — second key table, same flaw (MEDIUM, mandatory per R5)
`browser_extension_api_keys` (`schema.prisma:314`) — `key String @unique`, plaintext, `makeSecret()` at `server/models/browserExtensionApiKey.js:10`. Untouched, it becomes the bypass for everything Step 1 fixes.

## 2. Dependencies and sequencing

Blocked on **#4 (P0-2 Postgres)** and **#5 (P0-6 queue/bus)** per R1/R4. Concretely:

- From P0-2: the Postgres datasource and the migration toolchain. Every schema change below is written against it.
- From P0-6: `EventBusDriver.publish()` (seam 10) and the transactional-outbox guarantee. Step 2's audit events and Step 5's SSO-issuance events publish through it, inside the same transaction as the mutation they describe.
- Independent of both: Step 3 (rate limit) and Step 4 (IP allowlist) touch no schema and emit no audit events, so they can be split into a first PR if PMO wants earlier movement. Flagged as an option, not a decision.

## 3. Implementation plan

Ordered so each step lands with its own tests and nothing half-migrates.

### Step 0 — replace the key generator (prerequisite for Step 1, per R6)
`makeSecret()` in both `server/models/apiKeys.js:7` and `server/models/browserExtensionApiKey.js:10` uses `uuid-apikey`, which is a Base32-Crockford encoding of a **UUID v4 — 122 bits of entropy**, below R6's 256-bit floor. Replace with `crypto.randomBytes(32)` (256 bits) rendered base64url, keeping a stable human-readable prefix. This lands before or with Step 1; hashing a 122-bit key would leave it brute-forceable regardless of the digest.

### Step 1 — digest and widen the key tables
- `api_keys` gains: `secretDigest` (HMAC-SHA-256 with `API_KEY_PEPPER`, per R6), `keyPrefix` (leading 8 chars, indexed), `scopes` (JSON array), `workspaceId?`, `expiresAt?`, `lastUsedAt?`, `revokedAt?`. Drop `secret`.
- Lookup is `WHERE keyPrefix = ?` (or directly on the indexed digest, since HMAC is deterministic), then `crypto.timingSafeEqual` on the digest. O(1), no table scan.
- `API_KEY_PEPPER` lives in env, never in the DB — that separation is what makes a DB dump alone useless. Absent pepper must fail closed at boot, not silently self-assign the way `EncryptionManager` does (`index.js:38-42`). Rotating the pepper invalidates every key; document it next to the forced-rotation release note.
- Presentation: the raw key is returned **once**, at creation. Nothing else ever returns it.
- Migration deletes every existing plaintext key (ruling at `phase0-foundation.md:177` — forced rotation, no customers yet). Release note required.
- `browser_extension_api_keys` gets the identical treatment in the same PR (F-7 / R5).

### Step 2 — scope-aware `validApiKey`
- Resolve key → build a seam 02 `Actor` (`type:"service"`, `scopedKeyId`, `orgId`, `workspaceIds`) on `response.locals`, so P0-5's engine consumes it unchanged.
- `requireScope("workspace.write")` per route; all 30 call sites get an explicit scope drawn from seam 02 action names (R3). Unknown or absent scope → 403, default deny.
- Update `lastUsedAt`; reject `revokedAt`/`expiresAt` keys.
- Publish an authentication event through the P0-6 bus carrying `scopedKeyId` (R4). Per seam 10 boundary, the event carries **no key material** — id and prefix only.

### Step 3 — rate limiting
`express-rate-limit` rather than a hand-rolled counter. Login: per-IP **and** per-username, temporary lockout, and **change the 200 to 429** when limited. General `/v1`: per-key and per-IP. Memory store is correct for single-node today; note the multi-node ceiling with a `ponytail:` marker and the upgrade path (shared store once horizontal scale is real).

### Step 4 — IP/CIDR allowlist
One config-driven middleware, default off. Empty list means allow-all so an unconfigured deployment does not brick itself; a non-empty list is enforced strictly.

### Step 5 — SSO scope lock (F-4)
- `issue-auth-token` requires an explicit `sso.issue` scope, not merely a valid key.
- Additionally refuse to issue for a target user whose role outranks the calling key's grant, so a low-scope key cannot mint an admin session.
- Fix the stale "1 hour" comment at `temporaryAuthToken.js:10`.
- Issuance publishes an audit event through the bus, with the calling `scopedKeyId` and the target user id.

### Step 6 — credential handling (scope per R2)
Three things, and explicitly **not** provider-secret migration:
- **(a)** `.env` written atomically with `0600` and correct owner — covers `dumpENV()` in `updateENV.js`.
- **(b)** No secret reaches any response body, log line, or audit event. Assert it: a test that scans serialised output for known secret values.
- **(c)** A `CredentialStore` interface plus an encrypted Postgres driver (AES-256-GCM, master key from env) used by the **new** API-key and browser-extension-key paths from Steps 1–2.

Moving provider secrets out of `.env` into that store is a **later task**. Until it ships, no doc, release note, or issue comment may claim secrets are encrypted system-wide.

### Testing
New tests live beside the existing 617, following current layout: `server/__tests__/utils/middleware/` (the pattern set by `workspaceDeletionProtection.test.js`), `server/__tests__/models/`, `server/__tests__/endpoints/`. Every DoD line below gets a test that can be demonstrated RED.

## 4. DoD (dispatch-ready)

- [ ] No plaintext API secret in any table — proven by a query over `api_keys` **and** `browser_extension_api_keys`.
- [ ] Generated keys carry ≥256 bits of entropy (R6) — test asserts the generator's output length and that it draws from `crypto.randomBytes`.
- [ ] A DB dump alone cannot yield a working key: with the dump but no `API_KEY_PEPPER`, no offline guess validates. Test constructs a candidate from dumped columns and shows it fails auth.
- [ ] Key lookup is O(1) — an indexed lookup, not a scan over all rows. Test proves auth cost does not grow with row count (or asserts a single indexed query).
- [ ] Digest comparison is timing-safe (`crypto.timingSafeEqual`); grep shows no `===` on digest values.
- [ ] Missing `API_KEY_PEPPER` fails closed at boot rather than self-assigning.
- [ ] Pre-migration keys are rejected after migration (forced rotation), stated in release notes.
- [ ] A key lacking the required scope gets 403 on a scoped route; test proves it per scope family.
- [ ] Scope strings match seam 02 action names exactly — grep shows no translation table (R3).
- [ ] N failed logins → 429 (not 200); test proves both the status change and the lockout window.
- [ ] IP allowlist: empty config allows, populated config denies a non-listed source; test proves both.
- [ ] `sso.issue` scope required for `issue-auth-token`; a key without it gets 403; a low-scope key cannot mint a session for a higher-privileged user. Test proves the whole chain, including the exchange at `/request-token/sso/simple`.
- [ ] Key-identity audit events arrive via the P0-6 bus; grep confirms no direct `EventLogs.logEvent` added by this task (R4).
- [ ] No secret value appears in any response body, log, or audit payload — test asserts by scanning serialised output.
- [ ] `.env` is written `0600` and atomically.
- [ ] `security-review` (Opus) passes with **active exploitation attempted**, not code reading: replay a pre-migration key, call cross-scope, brute-force login, and run the full SSO impersonation chain from F-4.
- [ ] `cd server && yarn test` green — 617 existing plus the new security block.
- [ ] RED proof: three randomly chosen new tests each fail when their guard is temporarily removed.

## 5. Issue split (dispatch-ready)

Five issues. The split is by blast radius: each is separately reviewable and separately revertable, and no issue leaves the tree in a half-migrated auth state.

| # | Issue | Steps | Blocked on | Size | Review |
|---|---|---|---|---|---|
| A | Key generator + digest + schema | 0, 1 | #4 (Postgres) | L | Opus + `security-review` |
| B | Scope-aware `validApiKey` across 62 routes | 2 | A, #5 (bus) | L | Opus + `security-review` |
| C | Rate limiting + IP allowlist | 3, 4 | nothing | M | Opus |
| D | SSO scope lock | 5 | A, B, #5 | M | Opus + `security-review` |
| E | `.env` hardening + secret-leak assertion + `CredentialStore` | 6 | A | M | Opus |

Notes for dispatch:
- **C is genuinely unblocked** — it touches no schema and emits no audit events, so it can start before #4/#5 merge if you want early movement. Your call; I will not start it unprompted.
- **B is the risky one.** 62 route references, each needing a deliberate scope choice; a wrong scope is a silent over-grant, not a test failure. Recommend splitting B by endpoint file into two or three PRs (`admin`+`document`+`workspace` = 37 of the 62) rather than one sweep, and having the reviewer check the scope table against seam 02 action names rather than reading diffs.
- **D depends on B** because the `sso.issue` scope only means something once scope enforcement exists. Landing D first would be theatre.
- **A forces key rotation** and breaks every existing integration. It should land at a moment PMO chooses, with the release note ready.

## 6. Evidence commands

Baseline (required — `server/node_modules` is absent on a clean checkout):

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd server && yarn install --frozen-lockfile && yarn test
# expect: Tests: 617 passed, 617 total (plus new security block)
```

Per-DoD evidence:

```bash
# Guarded route inventory (the 62 / 9-file count in F-2)
grep -rn "validApiKey" server/endpoints/api/*/index.js | grep -v "require(" | wc -l
for f in server/endpoints/api/*/index.js; do \
  echo "$(grep "validApiKey" "$f" | grep -vc "require(")  $f"; done

# No plaintext secret columns remain (R6 / DoD 1)
grep -nE "secret|key" server/prisma/schema.prisma | grep -i string
psql "$DATABASE_URL" -c "select id, key_prefix from api_keys limit 5;"
psql "$DATABASE_URL" -c "\d api_keys"          # expect secretDigest + index, no secret

# Scope strings match seam 02, no translation table (R3 / DoD 4)
grep -rn "scopes\|requireScope" server/utils/middleware/ | grep -v test
grep -rn "SCOPE_MAP\|scopeAlias\|translateScope" server/   # expect: no matches

# Audit goes through the bus only, no new EventLogs calls (R4 / DoD 8)
git diff master...HEAD -- server/ | grep -n "^+.*EventLogs.logEvent"   # expect: no matches
git diff master...HEAD -- server/ | grep -n "^+.*publish("             # expect: bus calls

# Timing-safe compare (R6 / DoD 5)
grep -rn "timingSafeEqual" server/utils/middleware/ server/models/
grep -rnE "secretDigest\s*===|=== *secretDigest" server/   # expect: no matches

# Entropy of the generator (R6 / DoD 2)
grep -rn "makeSecret" server/models/apiKeys.js server/models/browserExtensionApiKey.js
grep -rn "uuid-apikey" server/models/                       # expect: no matches after Step 0

# .env permissions (DoD 10)
stat -f "%Sp %Su" server/.env.development                   # expect: -rw------- <owner>

# RED proof (DoD 13): pick three new tests, remove each guard, expect failure
cd server && yarn test path/to/new.test.js
```

`security-review` must run as active exploitation, not review-by-reading: replay a pre-migration key, call a route outside the key's scope, brute-force `POST /request-token`, and walk the full F-4 chain (`/v1/users/:id/issue-auth-token` → `/request-token/sso/simple` → session JWT) with a key that lacks `sso.issue`.

## 7. Resolved questions

All four recon questions are closed by R1–R4. The hash choice previously left open is closed by **R6** (HMAC-SHA-256 with a server-side pepper), which also surfaced Step 0: the current `uuid-apikey` generator produces 122-bit keys and must be replaced before digesting means anything. No open questions remain.
