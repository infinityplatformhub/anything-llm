# ApproofWorkspace code standards

Owner: Techlead. Scope: `server/` and anything we author in this fork.

This fork diverges from upstream AnythingLLM far enough that upstream review is
no longer a safety net. These are the conventions we enforce ourselves. Each rule
exists because a specific integration defect was found or forecast — the reason is
stated so the rule can be argued with, not just obeyed.

Rules are normative: **MUST** blocks merge, **SHOULD** is a review comment.

---

## 1. Database and Prisma

### 1.1 Timestamps MUST be `@db.Timestamptz(3)`

Every `DateTime` field in `server/prisma/schema.prisma` MUST carry
`@db.Timestamptz(3)`, including nullable ones.

```prisma
createdAt   DateTime  @default(now()) @db.Timestamptz(3)
leaseUntil  DateTime? @db.Timestamptz(3)
```

Why: Prisma emits naive `TIMESTAMP(3)` without it. Naive columns compared against
a tz-aware `now()` drift by the server's UTC offset. This is not cosmetic — the
fields that lost it in review were `password_reset_tokens.expiresAt`,
`temporary_auth_tokens.expiresAt`, and job lease expiry: token lifetime and lease
correctness both depend on it.

Exception requires an inline comment naming the reason. There is currently none.

Attribute order is `@default`/`@updatedAt` first, then `@db.`, single-spaced:

```prisma
createdAt DateTime @default(now()) @db.Timestamptz(3)   // yes
createdAt DateTime @db.Timestamptz(3)  @default(now())  // no — reformat noise
```

Check:

```bash
grep -n 'DateTime' server/prisma/schema.prisma | grep -v Timestamptz
```

Must print nothing.

### 1.2 Migration folders MUST NOT share a timestamp

Prisma orders migrations by lexical folder name, not by content or dependency.
Two folders sharing a timestamp prefix are ordered by the suffix, which is
arbitrary — `20260902000000_core_services` sorted before `20260902000000_init`
and tried to `ALTER TABLE "event_logs"` before the table existed.

Convention: **one hour of timestamp space per track**, allocated when the branch
opens.

| Track | Timestamp slot |
|---|---|
| P0-2 Postgres baseline | `20260902000000` |
| P0-6 core services | `20260902010000` |
| P0-5 authorization (T-1…) | `20260902020000` |
| P0-4 key hardening (PR-3…) | `20260902030000` |
| next track | `+010000` |

**The slot is claimed when the branch opens, not when the first migration is
written.** State it in the issue. A track that waits until it needs a migration
finds the free-looking hour already spoken for by an unmerged branch — which is
exactly how PR-3 ended up inside P0-5's slot, one lexical coin-flip away from
running `key_hardening` and `t1_authz_schema` in the wrong order.

Before opening a migration, run `ls server/prisma/migrations/` **and check the
open branches** — an unmerged branch's slot is taken. Renaming after a merge is
not an option: `_prisma_migrations` stores the folder name, so every environment
that already applied it sees a rename as a brand-new migration.

Within a track, later migrations step by `+001000` (`…030000`, `…031000`).

### 1.3 One dialect

`provider = "postgresql"` is the only supported datasource. Migration SQL is
plain Postgres. Do not add SQLite fallbacks, dual-dialect branches, or
`migration_lock.toml` edits — the SQLite path was removed deliberately in P0-2.

A branch whose `migration.sql` uses Postgres syntax MUST NOT be merged before
P0-2 is on `approof/main`; it cannot be tested standalone.

### 1.4 New models go at the end of the schema, in a marked block

```prisma
// BEGIN P0-6 CORE SERVICES — keep block at end for Postgres migration rebase.
...
// END P0-6 CORE SERVICES.
```

Why: appending keeps concurrent branches out of each other's hunks. Editing an
existing model in the middle of the file conflicts with every branch that
reformatted near it. Do not reflow or realign models you are not changing —
whitespace-only edits to shared models are the single largest source of
schema conflicts in this fork.

### 1.5 `filename` is a label, not a key

`workspace_documents.filename` is a **basename** — `documents.js` stores
`path.split(/[/\\]/).pop()` in it, while the full path goes in `docpath`. Two
tenants who both upload `report.pdf` produce two rows with an identical
`filename`.

So: **`filename` MUST NOT appear in a `where` clause.** It is for display, logs,
and progress events. The identity of a stored document is `docpath`
(`docId` where you have it).

Why: a lookup keyed on `filename` silently addresses another tenant's document.
It does not error — it returns a row, the wrong one — so it surfaces as data
corruption or a cross-tenant leak, not a stack trace. This has now been found
three times: the `#13` sync bloom, four call sites in
`server/models/documentSyncQueue.js`, and again in `sync-watched-documents.js`.
The comment at `documentSyncQueue.js:96` calls it "the same unique filename";
the schema does not declare it unique, and it is not.

The one exception is `workspace_parsed_files.filename`, declared `@unique` in
`schema.prisma`. There the column *is* the identity by design; querying it is
correct.

Definition of done for any change touching document lookup:

```bash
grep -rn "where.*filename\|filename:" server/models server/jobs
```

Every hit must be a write, a display value, or the `workspace_parsed_files`
exception. No read filter.

---

## 2. Audit and events

### 2.1 `emitAuditEvent`, never `EventLogs.logEvent`

After P0-6, `EventLogs.logEvent` is not called directly from endpoints, models,
or helpers. Use:

```js
const { emitAuditEvent } = require("../utils/events");
await emitAuditEvent("failed_login_invalid_password", { ip }, userId);
```

Why: P0-6 routes audit through the outbox so the event commits in the same
transaction as the mutation it describes (seam 10). A direct `logEvent` write
bypasses the outbox and can leave a mutation audited-but-not-committed, or
committed-but-not-audited. 95 call sites were converted; new ones must not
reintroduce the old path.

`publishOperationalEvent` is for infrastructure facts (job dead-lettered,
delivery failed), not user-attributable actions. Operational events MUST NOT
re-enter the audit subscriber — no recursive audit loops.

Check:

```bash
git grep -n "EventLogs.logEvent" -- server/endpoints server/models server/utils/helpers
```

Must print nothing outside `server/models/eventLogs.js` itself.

### 2.2 Event identity

`eventId` is a UUID generated by the emitter. Republishing the same `eventId`
with an identical payload hash is a no-op; with a different hash it MUST throw
`EventConflictError` (seam 10). Do not "fix" a conflict by regenerating the id —
that hides a real divergence.

---

## 3. Errors

### 3.1 Seam error classes live in one module per seam

Error classes named in a seam contract are part of that seam's public surface.
They MUST be defined in a dedicated `errors.js` beside the seam, not inside a
driver implementation, and re-exported by the driver for compatibility:

```
server/utils/jobs/errors.js     → LeaseLostError, ImpersonatedMutationError
server/utils/events/errors.js   → EventConflictError, UnknownEventVersionError
server/utils/authorization/errors.js → AuthorizationDeniedError
```

Why: today `EventConflictError` is only reachable via
`require("./events/PostgresEventBus")` — a caller that catches it is coupled to
the *first driver*, not the seam. The moment a second driver exists, or P0-5
starts throwing across seams, every `catch` site breaks. Seam 02 already names
`AuthorizationDeniedError` in its contract; it should be born in the right place.

### 3.2 Error shape

- Subclass `Error`, name the class for the condition, not the site.
- No credentials, tokens, secrets, or document content in `message` or in any
  persisted error field (`jobs.lastError`, `job_dead_letters.error`,
  `event_deliveries.lastError`) — these are readable by operators.
- Throw for contract violations. Return a decision object for expected denials:
  `authorize()` returns `{allowed:false, reason}`, `assertAuthorized()` throws.

### 3.3 Default deny

Authorization failures — missing actor, unknown action, unresolvable policy,
driver error — deny. A `catch` that falls through to allow is a merge blocker.

### 3.4 HTTP status contract

One meaning per code. These are not interchangeable: a client, a log, and an
on-call engineer each read them differently, and the wrong one sends all three
to the wrong conclusion.

| Code | Means | The question it answers |
|---|---|---|
| **401** | Not authenticated | *Who are you?* — no credential, expired, or unparseable |
| **403** | Authenticated, not permitted | *You, specifically, may not do this* |
| **404** | Exists but its existence is not yours to know | *Is there such a workspace?* — answered as "no" on purpose |
| **503** | Policy store unavailable | *We cannot decide right now* — not a denial |

**401 vs 403 is the one that gets confused, and legacy code has it wrong.**
`flexUserRoleValid` answers 401 for a request that authenticated perfectly well
and merely lacks the role. That tells the client "your credential failed", which
is false — retrying with the same credential is correct behaviour for a 401 and
pointless here. T-4a converts eleven tests from 401 to 403 for exactly this
reason, and the conversion is a **fix, not a compatibility break**.

**404 over 403 for secret existence.** A 403 on `GET /workspace/:slug` confirms
the workspace exists. Enumerate slugs against a 403/404 split and you have a
directory of every workspace in the org without reading one. So: a non-member
asking for a workspace gets **404**, identical to a slug that was never real.
This applies to any resource whose existence is itself information — workspaces
today, and anything named by a user-chosen slug later.

The cost is a worse error message for a legitimate user who mistyped nothing and
simply is not a member. That trade is deliberate: the user asks an admin, while
the enumeration attack gets nothing.

**503 is not a denial.** When the policy store is unreachable, the engine cannot
decide. Returning 403 says "we decided, and the answer is no", which is a lie
that sends the user to an admin to fix permissions that were never the problem.
Return 503 so it reads as an outage — which it is. This does not contradict §3.3:
the request is still denied access, it is just not *reported* as an authorization
decision.

**Frontend note.** Nothing in `frontend/src` logs the user out on a 401 today —
verified by grep (`frontend/src/utils/session.js:11` checks only `status === 200`).
So the 401→403 correction breaks no client behaviour now. If a logout-on-401
interceptor is ever added, it must land **after** this contract is uniform, or
every legacy 403-shaped-as-401 will silently log people out mid-session.

---

## 4. Authorization vocabulary (seam 02)

Use the contract's strings verbatim. Do not invent synonyms; a typo'd action
string silently default-denies or, worse, silently matches nothing in a filter.

- `Actor.type`: `"user" | "service" | "embed"`
- Action strings are dotted `resource.verb`, e.g. `document.read`,
  `document.search`, `access.diagnose`. `documentFilter()` accepts only
  `document.read` and `document.search`.
- Decision: `{allowed, reason, matchedPolicyIds}` — `reason` is always populated,
  including on allow, because audit records it.
- `DocumentAclFilter.matchNone: true` is how an empty scope is expressed. Never
  express it as an empty `allowedDocumentIds` array — an empty allow-list is
  ambiguous with "no restriction" at the query layer.
- Background jobs and service accounts supply an explicit `Actor`. They MUST NOT
  inherit the creating user's permissions.
- Impersonated actors (`impersonatedBy` set) keep read scope; every mutation is
  denied regardless of scope.

---

## 5. Module boundaries

- Endpoints (`server/endpoints/`) do routing, input validation, and response
  shaping. No SQL, no `prisma` import.
- Models (`server/models/`) own persistence for one aggregate.
- Seam drivers (`server/utils/{jobs,events,authorization,...}/`) are constructed
  with their dependencies injected and defaulted:

  ```js
  constructor({ db = prisma, now = () => new Date() } = {}) {}
  ```

  Why: this is what makes the seams testable without a database, and it is
  already the pattern in `PostgresJobQueue` / `PostgresEventBus`. Follow it.
- A seam's `index.js` exports the wired singleton and the functions callers use.
  Callers import from the seam directory, never from a driver file directly.
- No cross-seam imports between drivers. Compose at `index.js` or at the caller.

### 5.1 A file that calls a model must require it

Node resolves `require` at load but resolves an identifier at *use*. A file that
calls `EventLogs.count()` without requiring `EventLogs` therefore boots fine and
throws `ReferenceError` only when that route is hit. Nothing in the test suite
catches it unless a test exercises that exact handler.

This is not hypothetical. Issue #24: the P0-6 audit sweep converted the write
path in `server/endpoints/system.js` to `emitAuditEvent` and removed the now-
unused-looking `EventLogs` import — but three read/delete call sites at lines
1152, 1155 and 1171 still used it. The Event Logs admin page 500'd until a user
reported it.

The rule is one line: **if a file calls `Model.method(...)`, that file requires
`Model`.** There is no ambient model object and no global.

The trap is specifically a *sweep*. When you remove the last call of one kind
from a file, the import can look dead while another kind of call still needs it.
Grep the file for the identifier before deleting its import, not just for the
pattern you were converting.

Check:

```bash
./scripts/check-model-imports.sh
```

Run it via `./scripts/check-local.sh` with the rest of our checks. It flags any
file calling `Model.method(` without a matching `require`, exempting the file
that declares the model. It matches only calls, so a string literal like
`"User.Read"` or a mention in a comment does not trip it.

Add new models to `MODELS` in the script as they appear; the list is the gate's
coverage, and a model absent from it is unchecked.

---

## 6. Naming

- Files: `PascalCase.js` for classes, `camelCase.js` for function modules —
  match the directory you are in rather than converting it.
- Prisma models: `snake_case` plural (`job_dead_letters`), matching the existing
  schema. Fields: `camelCase`, except where an existing table already uses
  `snake_case` (`user_id`, `thread_id`) — do not rename those; a rename is a
  whole-table migration.
- Env vars: `SCREAMING_SNAKE`, prefixed by subsystem where ambiguous.
- Do not introduce an abbreviation that is not already in the codebase.

### 6.1 Credential prefixes

Every generated bearer credential MUST carry an `apw-` prefix naming its kind:

| Credential | Prefix | Generator |
|---|---|---|
| Developer API key | `apw-key-` | `server/models/apiKeys.js` |
| Temporary auth token | `apw-tat-` | `server/models/temporaryAuthToken.js` |
| Browser extension key | `apw-brx-` | `server/models/browserExtensionApiKey.js` |
| Invite code | `apw-inv-` | `server/models/invite.js` |

Why: a prefix makes a leaked credential identifiable in a log or a paste, lets
`startsWith` route a token to the right verifier, and keeps the fork's
credentials distinguishable from upstream's. Every kind carries its own segment —
a bare `apw-` for API keys would not be dispatchable, since it also prefixes every
other kind, forcing a check-the-specific-ones-then-fall-through order that breaks
the moment a new kind is added. Adopting it late is expensive —
every old prefix has to be accepted forever — so it is settled now, before any
of these ship.

Entropy: **256 bits minimum**, `crypto.randomBytes(32).toString("base64url")`.
Do not use `uuid-apikey` — a UUIDv4 in Base32 is 122 bits, below the floor.

A generator that changes prefix MUST be checked for consumers that parse the old
one (`grep -rn "<old-prefix>" server frontend embed`). Changing a prefix with a
live consumer is a breaking change requiring a `startsWith` compatibility branch.

---

## 7. Tests

Jest, `yarn test` from `server/`, `--runInBand`.

### 7.0 Running the suite locally

The suite needs a real Postgres, a pepper, and a Prisma client that matches the
schema you are on. Miss any of the three and you get failures that are not about
your code:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"        # Node 22
export DATABASE_URL="postgresql://approof:approof@localhost:5432/approofworkspace_test?connection_limit=5"
export API_KEY_PEPPER="local-dev-api-key-pepper-32-bytes-min"   # >= 32 bytes
cd server
npx prisma generate --schema prisma/schema.prisma        # after EVERY rebase
npx prisma migrate deploy --schema prisma/schema.prisma  # fresh database only
yarn test
```

Postgres, if you do not already have one:

```bash
docker run -d --name approof-test-pg \
  -e POSTGRES_DB=approofworkspace_test -e POSTGRES_USER=approof \
  -e POSTGRES_PASSWORD=approof -p 127.0.0.1:5432:5432 postgres:16
```

**`API_KEY_PEPPER` must be set and at least 32 bytes.** `utils/apiKeySecurity`
calls `assertApiKeyPepper()` at module load, so a missing pepper fails five
suites at `require` time, before a single test runs. That is fail-closed by
design — a server that would hash API keys with an absent pepper must not
start — not a bug to work around. CI sets it at `.github/workflows/ci.yml:30`.

**The generated Prisma client must match the schema you are on.** It lives in
`node_modules`, which git does not track, so it keeps whatever schema it was
last built from. A client built before a schema change does not know the new
columns and reports them as unknown fields — this produced **57 false failures**
in one session, none about the code under test. If many unrelated suites fail
right after a rebase, regenerate before reading a single stack trace.

`yarn test` already runs `prisma generate` first (see `server/package.json`), so
it is safe by default. The trap is running `npx jest` directly — faster, and the
way you end up invoking a single suite — which does not. Regenerate by hand
whenever you bypass `yarn test`.

The same trap hits worktrees that share a `node_modules` with the main checkout:
whichever tree generated last wins and the other one fails, even under
`yarn test`, because both write to the same client. Regenerate when you switch
between them.

- Location mirrors source: `server/utils/jobs/X.js` →
  `server/__tests__/utils/jobs/X.test.js`.
- Seam tests use a hand-written in-memory fake for `db`, injected via the
  constructor. No live database, no mocking framework, no snapshot tests for
  logic. `server/__tests__/utils/coreServices/coreServices.test.js` is the
  reference.
- Every security fix ships with a test that fails without the fix. State the
  attack in the test name (`rejects issuance when key lacks SSO scope`), not the
  mechanism.
- Concurrency claims (lease, claim, idempotency) need a test that exercises two
  actors against the same row. "It compiles" is not evidence of atomicity.
- Do not assert on log output.

### 7.3 No `#` or `//` in a test title

A `describe()` / `it()` title MUST NOT contain a `#` or a `//` when the line ends
in `{`. Write the issue number as a word.

```js
describe("SSO issuance lock over HTTP - QA-2 issue 8", () => {   // ok
describe("rejects http-colon-slash-slash evil.example callbacks", () => {  // ok

describe("SSO issuance lock (HTTP, #8 QA-2)", () => {            // blocked
describe("SSO issuance lock over HTTP - QA-2 #8", () => {        // blocked
describe("rejects http://evil.example callbacks", () => {        // blocked
```

This is a **tooling constraint, not a style preference** — do not "fix" it back.

`task.sh check` runs a commented-out-code gate over added lines. It finds a
comment by splitting the line at the first `//` or `#`, then flags the remainder
if it ends in `{`. A test title containing either token makes the gate read the
rest of the line — `8", () => {` — as a comment that opens a block, and the
issue cannot be closed. The gate is deliberately conservative about what it
treats as human prose, and this shape falls on the wrong side of it.

#### The same split hits JS private fields

`#` is also JavaScript's private-field sigil, and the gate splits on it wherever
it appears — including mid-expression, in ordinary code with no comment at all:

```js
if (this.#hasDiskCache) {      // gate reads the "comment" as `hasDiskCache) {`
```

That ends in `{`, so it is flagged. Verified by running the gate's own logic
(`task.sh` `gate_commented_code`, the `*\#*) comment="${content#*#}"` branch)
against that exact line.

The exposure is not small: **124 files under `server/` use private fields, and 59
lines across 16 files already match the flagged shape** — every `AiProvider`,
`BackgroundWorkers`, `EncryptionManager`, `ModelPricing`. They pass today only
because the gate reads *added* lines, so a file trips it the day it is edited,
not the day it was written. Anyone adding a private field to a class inside an
`if` or a callback will hit this with no idea why.

Workaround, until the gate is fixed — lift the condition into a local:

```js
const hasDiskCache = this.#hasDiskCache;   // no `{` at end of line
if (hasDiskCache) {                        // no `#` on this line
```

Do this only where the gate actually blocks you. Rewriting working code to
appease a tool is a cost; paying it across 124 files is not worth it, and the
real fix belongs in the gate.

**Fix filed upstream** (infi-skills): the comment split should not treat `#` as
a comment start when it directly follows a `.` and is followed by an identifier —
that is unambiguously a private-field access, never a comment, in any language
the gate covers. `//` needs no such carve-out.

The general shape is one this repo has hit twice now in its own gates: **a gate
whose false positive lands on correct code teaches people to bypass it**, which
is worse than the gate not existing. Both times the fix was to match the precise
construct rather than the loose token — the call form for `db push`, the
declaration for model imports.

It has cost three issues (#8, #11, #14) roughly ten minutes each. Both tokens
trip it: `#` for issue references, `//` for any URL in a title (`http://…`).

Everything else about the title is unconstrained; only these two tokens matter,
and only on a line ending in `{`.

### 7.3a Test titles never start with `#`
- The commented-out-code gate reads `#` on a line ending in `{` as a comment. Write `issue 52:` not `#52:` in describe/it titles. Hit on #39, #46, #52, #32-era; check before `task.sh check`.

### 7.4 Do not write `postgresql://` as a literal in test setup

The same gate as §7.3, different token. A line containing `//` that ends in `{`
is read as a block-opening comment:

```js
if (!baseDatabaseUrl?.startsWith("postgresql://")) {   // blocked
```

Fix by keeping the scheme out of the string, or the `{` off the line:

```js
const PG_SCHEME = "postgresql:";                            // ok
if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {

if (new URL(baseDatabaseUrl ?? "").protocol !== "postgresql:") {   // ok, and validates
```

Three files carry the blocked form today —
`server/__tests__/envDumpGuardHttp.test.js:19`,
`ssoIssuanceLockHttp.test.js:20`, `api/regression.test.js:13` — and are exempted
in `.infi/checkignore` to unblock them.

**That exemption also disables `gate_markers` on those three files**, because
`.infi/checkignore` is per-file, not per-gate: it silences the marker gate, the
commented-code gate, and the URL gate together (`gate_secrets` and
`gate_skipped_tests` keep running). A `TODO` or `FIXME` left in those three
security suites will not be caught by tooling. Until the literal is removed and
the exemption dropped, a reviewer has to check them by eye.

The next person to touch any of those files should apply the fix above and
delete its `.infi/checkignore` line in the same commit.

### 7.1 A fake database cannot validate SQL

The in-memory fake above is the right default, and it has one blind spot: it
answers every query the way the test author expected, including queries Postgres
would reject. A suite built entirely on it stays green while the feature is
broken in production.

This is not hypothetical. `PostgresJobScheduler.materialize()` called
`$queryRawUnsafe("SELECT pg_advisory_xact_lock($1)")`, which fails on real
Postgres — Prisma cannot deserialize a `void` return — aborting the transaction
every time. Recurring jobs never materialized, `nextRunAt` stayed null, and an
error repeated on every scheduler tick. All 632 unit tests passed, `prisma
migrate deploy` succeeded, and `prisma migrate diff` reported no drift. None of
those checks execute application queries; the fake supplied `$queryRawUnsafe`
itself.

So: **changes that touch raw SQL, transactions, background workers, or
schedulers MUST ship at least one integration test that runs against a real
Postgres.** One case is enough — it only has to execute the statement the fake
was standing in for.

```js
// Skips locally without a database; CI always has one (ci.yml provides postgres:16).
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb("PostgresJobScheduler against real Postgres", () => { /* ... */ });
```

Raw SQL specifically:

- Prefer a Prisma model call. Reach for raw SQL only for something Prisma cannot
  express (advisory locks, `SKIP LOCKED`).
- `$queryRaw` returns rows. A statement returning `void` or no rows goes through
  `$executeRaw`, which returns an affected-row count.
- Use the tagged-template forms (`$queryRaw`/`$executeRaw`) so values are bound
  as parameters. `*Unsafe` requires a comment justifying it.
- A `typeof tx.$queryRawUnsafe === "function"` guard makes the statement
  disappear under a fake instead of failing loudly. If a statement is required
  for correctness, do not guard it — let the fake break, and fix the fake.

### 7.1a A test database is built by `migrate deploy`, never `db push`

`prisma db push` shapes the schema from `schema.prisma`. It does not run
migration files, so **it skips every `INSERT` those files carry.** The schema is
right and the data is missing, which is worse than a schema error: the tables all
exist, so nothing throws — the rows are simply not there.

The gap is real and was live for weeks. Five migrations carry seed data:

| Migration | INSERT statements |
|---|---|
| `20260902020000_t1_authz_schema` | 21 (57 permission rows + roles + grants) |
| `20260902040000_pr4b_workspace_thread_scopes` | 3 |
| `20260902041000_pr4b_document_scopes` | 3 |
| `20260902042000_pr4b_embed_scopes` | 2 |
| `20260902043000_pr4b_system_openai_scopes` | 2 |

Every HTTP suite built with `db push` therefore ran against a database with an
**empty `permissions` table**. `engine.evaluate()` returns `unknown_action` for
every action when that table is empty, so authorization tests in those suites
were asserting against a system that denied everything for the wrong reason. They
passed. They would have passed with the engine deleted.

So: **any suite that boots the app or exercises authorization builds its database
with `migrate deploy`.**

```js
// right
spawnSync(prismaBin, ["migrate", "deploy", "--schema", testSchema], { env });

// wrong — schema without seed data
spawnSync(prismaBin, ["db", "push", "--skip-generate", "--schema", testSchema], { env });
```

The gate caught its first live case within a day of landing: the #34 hotfix
added a new HTTP suite built with `db push`, and `check-db-push.sh` flagged it
before merge. That is the intended shape — a rule that only exists in a document
is one every new test has to be told about individually, and the tests that most
need it are the ones written by whoever has not read it yet.

`db push` is legitimate in exactly one place: a test whose subject is the schema
shape itself and which seeds its own rows. Those go in the allowlist at the top
of `scripts/check-db-push.sh`, with a comment saying why — the allowlist is the
record of the decision, so an entry without a reason is a bug.

Check:

```bash
./scripts/check-db-push.sh
```

Run via `./scripts/check-local.sh`.

This is the same failure as §7.1 one layer down: there, a fake stood in for
Postgres and hid a broken statement; here, a real Postgres stood in for a
migrated one and hid missing data. Both pass every check that does not look at
what the application actually reads.

### 7.5 Rewriting a middleware means testing the routes under it

A middleware and the routes beneath it share an undeclared contract: what the
middleware puts on `response.locals`, and what each route reads back. Nothing
checks it. Express throws at the *read*, not at the wiring, so a route whose key
stopped being written 500s in production while every existing test stays green.

Issue #34. PR-3 (`fcf09619`) rewrote `validBrowserExtensionApiKey` to write
`locals.apiKeyContext`. Two routes still read `locals.apiKey.id`:

```js
// validBrowserExtensionApiKey.js:26
response.locals.apiKeyContext = context;

// browserExtension.js:30 and :50 — unchanged
const apiKeyId = response.locals.apiKey.id;   // TypeError, 500
```

`/browser-extension/check` and `/browser-extension/disconnect` were dead from
that commit onward. An 895-test green run said nothing, because no test touched
either route. A user found it.

Two rules follow:

**1. Rewriting a middleware means the PR carries an HTTP test for every route
under it.** Not a unit test of the middleware — a request through the stack that
asserts the status the route is supposed to return. Write it against the
pre-change code first and watch it fail; a test written after the fix proves the
fix, not the contract.

**2. Every `response.locals` key a route reads must be written somewhere.** This
half is mechanical:

```bash
./scripts/check-locals-contract.sh
```

It compares the keys read under `server/endpoints/` against the keys assigned
anywhere under `server/`, and names any read with no writer. Run via
`./scripts/check-local.sh`.

`locals.apiKey` sits in the script's PENDING list while #34 is in flight: reported
every run, not failing the gate, so this landed before the fix. Delete the entry
when #34 merges. A PENDING entry with no open issue is a bug, not a waiver.

The gate finds a live bug the day it is added, which is the point — it was found
by running it, not written from a description of the bug. It cannot see a key
whose *shape* changed (`locals.user` going from a row to an id), so rule 1 is not
optional because rule 2 exists.

**Not proposed: a route-coverage gate.** Diffing middleware files, resolving
which routes mount them, and grepping tests for those paths is three inferences
deep — Express mounts middleware in arrays, at routers, and conditionally, so the
route list is not reliably greppable. A gate that is wrong in either direction is
worse than a review item: false negatives teach people it is covered, false
positives teach people to bypass it. Rule 1 stays a review item; rule 2 is
mechanical because it needs no inference at all.

### 7.6 A migration that adds a model needs `prisma generate` before review

The generated client lives in `node_modules`, which is untracked. Adding a model
to `schema.prisma` does not create `prisma.<model>` for anyone who has not
regenerated — including the reviewer, the gate run, and CI.

What makes this worth a rule rather than a note is **how it fails**: not with
"unknown model", but quietly, in whichever direction the calling code was written
to be safe.

Two cases, one week apart:

- `reportLegacyWildcardGrants` reads `api_key_legacy_wildcard_grants` inside a
  `try/catch`. Without generate the model is undefined, the throw is caught, and
  the boot report prints **count 0** — which reads as "no legacy keys", the exact
  opposite of the truth, at the one moment an operator is looking for them.
- `credential_store`'s test died at import with an error that pointed at the test
  rather than at the client.

Neither says "run generate". The first says nothing at all.

So: **an issue or ledger that ships a new model states that `prisma generate`
must run before any gate or review**, and the reviewer runs it. `yarn test`
already does (`server/package.json`, `"test": "prisma generate && jest"`), which
is why this bites review and boot rather than the suite — the two paths that
skip it.

```bash
cd server && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
```

Not `npx prisma`: npx resolves to whatever the npm cache holds, which on at least
one machine here is Prisma 8 against a Prisma 6 schema, and the failure reads like
a schema error.

Worktrees make it worse: they share the main checkout's `node_modules` by
symlink, so whichever tree generated last wins, and a stale client in one tree
produces `PrismaClientValidationError` in another that changed nothing.

### 7.7 Test fixtures create membership through the model, never raw Prisma

Since T-4a (`20260902044000`), workspace membership **is** workspace access: the
org-wide `member` role no longer carries workspace actions, and the engine reads
`principal_role_grants`. `WorkspaceUser.create` writes the row **and** calls
`syncWorkspaceMembershipGrant`, which is what puts the grant there.

A fixture doing `prisma.workspace_users.create(...)` writes the row and no grant.
The user is a member by the table and a stranger to the engine — so an
authorization test built that way asserts denial and passes for the wrong reason.
It would pass with the feature deleted.

```js
// wrong — membership with no grant
await prisma.workspace_users.create({ data: { user_id, workspace_id } });

// right — the model moves the grant with it
const { WorkspaceUser } = require("../models/workspaceUsers");
await WorkspaceUser.create(userId, workspaceId);
```

Two exemptions, both narrow:

- **The migration's own test.** `__tests__/prisma/t1-authz-migration.test.js:81`
  writes rows raw on purpose — it is testing what the migration does to
  pre-existing rows, and pre-existing rows had no grants. Using the model there
  would test the model.
- **A fixture that deliberately builds the inconsistent state** — membership
  without a grant, to prove the engine denies it. Say so in a comment, or the
  next reader fixes it into uselessness.

Everything else goes through the model. The general form: **when a write has a
side effect that another subsystem depends on, a fixture that skips the model
skips the side effect**, and the test then measures a world the product never
produces.

### 7.8 After T-4b, single-user is a database fact — review on a fresh database

`isConfirmedSingleUser` (`actorResolver.js`) no longer trusts the
`multi_user_mode` setting alone. It reads `users.count()`, because a setting that
says single-user while user rows exist is not evidence of anything (FINDING-1:
the settings read failing open resolved anonymous requests to `SINGLE_USER_ACTOR`,
which holds the seeded `super_admin` grant).

That is the right fix, and it changes what a test database has to be:

**A leftover user row makes the R5 single-user tests fail — and the failure names
the test, not the row.** QA-2 hit this: a probe left a user behind, the next run
took the deployment for multi-user, and a correct assertion went red with nothing
in the output pointing at the cause.

So: **run the gate and any authorization review against a freshly migrated
database**, not one carried over from a previous probe.

```bash
DB="gate_$$"
psql "postgresql://…/postgres" -c "CREATE DATABASE $DB;"
export DATABASE_URL="postgresql://…/$DB?connection_limit=5"
cd server && ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
# … run …
psql "postgresql://…/postgres" -c "DROP DATABASE $DB;"
```

`$$` is the shell PID, so parallel runs do not share a database — the same reason
the per-process test schemas exist (§7.0).

This is §7.1a's lesson at the row level rather than the schema level: there, a
database built the wrong way was missing seed data; here, a database *reused* is
carrying rows that change an answer. Both produce a confident wrong result rather
than an error.

**A second identity surface.** `resolveActorRef` reads the actor from a job row
(`{type, id}` as stored by whoever enqueued it), which means job rows are an
identity input that no ingress middleware guards. Today every enqueue is
first-party, so this is a noted primitive rather than a hole — but a future
feature that lets a request choose a job's actor turns it into privilege
escalation with no middleware in the path. Recorded in
`docs/superpowers/residual-risks.md`; anything that widens who can enqueue must
answer it first.

### 7.2 Definition of done for background services

A scheduler, worker, or pump is not done because its tests pass. Before handing
off, boot the app the way production does and confirm it is actually working:

```bash
NODE_ENV=production node index.js     # from server/
```

- No repeating error in the log across at least 3 tick intervals.
- The state the service is supposed to write is present in the database —
  query it (`nextRunAt` populated, delivery rows acknowledged, jobs claimed).
  A quiet log is not evidence; an empty table with a quiet log means the work
  never ran.
- Say in the handoff what you observed, not that it "should" work.

Why: unit tests prove the logic you modelled. Booting proves the logic you
actually shipped, against the driver, the schema, and the wiring in
`utils/boot/index.js`.

---

## 8. Merge discipline

- Branch from `approof/main`; rebase rather than merge `main` into a feature
  branch.
- A branch that changes `schema.prisma` MUST state its migration slot (§1.2) in
  the issue before the first migration is written.
- Branches touching the same file are serialized by the Techlead's conflict
  forecast, not resolved ad hoc. Ask before rebasing onto an unmerged branch.
- Whitespace-only reformatting of shared files (`schema.prisma`,
  `endpoints/system.js`, `utils/helpers/updateENV.js`) is not allowed in a
  feature branch. It converts a clean auto-merge into a manual conflict.

### 8.1 Adding a developer API route breaks someone else's test

`server/__tests__/endpoints/apiRouteAuthSweep.test.js` asserts an exact route
count across `server/endpoints/api/*/index.js` (currently **63**). It is exact on
purpose: a route that appears without anyone noticing is how
`GET /v1/system/env-dump` shipped unauthenticated.

If you add or remove a `/v1` route, update that number **in the same commit**.
Otherwise the suite fails on a branch that never touched your code, and the next
person spends an hour bisecting someone else's feature.

Every `/v1` route MUST carry `validApiKey` in its middleware array. The sweep
enforces this; do not register a route as `app.get(path, handler)` with no array.

### 7.9 RED must fail for the right reason
- A RED run where every test fails identically regardless of code (missing env, DB refused, import crash) is not evidence. Read the failure cause before counting reds.
- A `404` assertion alone never proves a route exists or is guarded: Express answers 404 for an unmounted route. Assert the body/shape too.
- A RED that hits a route with the wrong HTTP method is a 404 for the wrong reason (T-7 S-20). Assert the method matches the mount before trusting the red.
- A negative test for an AND rule must use a principal holding exactly one half; a principal seeded with both halves cannot prove the AND (T-7 D-2).
- Mint/issue endpoints are part of the threat model: a credential that any caller can mint for any subject proves nothing (#32 stream-chat oracle, QA-1).
(Source: T-7 #31 ledger, #32 review, 2026-09-02.)

### 7.10 The prisma client is a process singleton bound at first require
- `utils/prisma` binds `DATABASE_URL` on first require; under `jest --runInBand` every later suite shares it. A suite that creates its own database must `jest.resetModules()` before requiring anything that touches prisma, or its fixtures land in the shared DB (T-7 #31: leaked users turned `actorResolver` R5 red in unrelated branches).
- `afterAll` cleanup is not the fix: it deletes the right rows from the wrong database.

### 7.11 A requested review is a merge gate
- When PMO has asked QA for a verdict on a SHA, the merge waits for that verdict even if the automated gate passes (T-7 #31 merged 20 minutes before QA-1's FAIL arrived; the hole went live on main → #52).
- Engine blanket denies only protect routes that reach the engine; every mutating route must carry `requirePermission` or an explicit guard, and "a route that forgets to check is still safe" is never a true comment.

### §7.9a summary line is not the verdict
A Jest run whose `Tests: N passed` line is green while any suite failed to load (e.g. `jsonwebtoken` import error under Node 26) is a FAIL. Gate reads `Test Suites:` too; evidence must run under node@22. Found on #43 dab75e1a.

### §7.9b XSW fixtures mirror the verifier's read path
A forged element planted for an XSW test must sit at the exact path the verifier reads (e.g. `Conditions/AudienceRestriction/Audience`, not a bare `AudienceRestriction`). Proof: mutate the reader to document-wide `//` and every planted fixture must go red. Found on #43 01888688 (2 of 4 fixtures proved nothing until reshaped).

### §7.6a probes run on a pinned SHA in QA's own detached worktree
Probing a developer's live worktree is void: uncommitted edits change results (QA-2 on #43). QA never writes into a dev worktree (QA-1 on #48).

### §7.3b JS private members trip the commented-code gate
`this.#method(` on a line ending in `{` is read as commented code by task.sh. Not a rule violation; add the file to `.infi/checkignore` (lance/index.js, #30 b35c73eb).

### §7.1b API_KEY_PEPPER must be ≥32 bytes in every test env
A shorter pepper makes 8 authorization suites fail at import with a pepper error, not a test error. Check this first when an authz group goes red (Dev3, #43 cd4fda5e).

### §7.3c XML namespace URIs trip the URL gate
`http://www.w3.org/...xmldsig#` and friends are identifiers, not endpoints. Add the file to `.infi/checkignore` (#43 4765dbae).

### §7.12 every vector predicate renderer needs a real-store test
Three renderers in one slice looked correct as strings and were rejected by the engine: LanceDB bare identifier (case-folded), pgvector placeholder numbering, Milvus `not exists a and not exists b` (precedence). A new provider or clause ships only with a test that executes the predicate against the real store (skip-if-unavailable is acceptable, string comparison is not). #30 slices 1a/1b.

### §7.6b every worktree installs its own node_modules
Never symlink to, or `yarn add` into, the main checkout's `server/node_modules`; it is shared by every worktree and a stray install breaks all of them. New deps from a merged branch (xml-crypto from #43) mean `yarn install` + `prisma generate` before any test run. (Dev3 on #60; Dev2/Dev4 hit the same on #50/#30 1b.)

### §7.9c layered defences shadow each other under mutation
Removing an inner check (LDAP `authenticated !== true`) killed no test because the outer guard (empty-password) rejected every fixture first. To prove an inner layer, feed an input the outer layer passes (`alwaysAnonymous` mock) or disable the outer layer in that test. An inner check no mutant can kill is dead code that looks tested. (Dev3, #60 f221df51; pairs with §7.9b.)

### §7.1c a baseline run uses a fresh database
A "pre-existing on main" claim is void if the baseline tree points at the same stale DB as the suspect tree (Dev5, #63: 20/22 migrations + unseeded → 5 apiKeys failures on both). Baseline = new DB + migrate deploy + seed.

### §7.13 CREATE EXTENSION names its schema
`CREATE EXTENSION IF NOT EXISTS x;` installs into the first schema on search_path and `IF NOT EXISTS` is schema-blind, so a test suite (or deployment) using `?schema=` leaves the operator class invisible from `public` and the migration fails mid-file. Always `CREATE EXTENSION IF NOT EXISTS x SCHEMA public;` and qualify operator classes (`public.gin_trgm_ops`). Found by Dev5 on #61.

### §7.9d source-scan tests strip comments and string literals
A test that greps source for `requirePermission(...)` passes when the gate is a comment. Strip `//`, `/* */` and string literals before matching, and keep a mutation where the real gate is commented out. (Dev2/reviewer on #40 task 1.)

### §7.9e gate-presence tests read the mounted router, not source text
A hand-written source scanner for `requirePermission(...)` was bypassed twice under mutation (commented gate; `notrequirePermission` prefix). Assert gate presence from the real router's middleware stack: `requirePermission` exposes `mw.action`/`mw.resolver` (like `validApiKey` exposes `middleware.scope`) and the test walks `app._router.stack`. (Dev2 on #40 task 1.)

### §7.14 one full suite per merge target
Full `yarn test` (1,600+ tests, 5–10 min) runs **once**, by the PMO gate on the final merge target. Everyone else runs only what the diff touches: developers iterate with `jest --findRelatedTests <changed files>` and send a SHA once related suites are green; QA and Techlead probe and mutate, they do not rerun the suite. Running the suite four times per SHA was the largest single source of latency on 2026-09-02.

### §7.6c every worktree starts with scripts/wt-bootstrap.sh
One command: node 22 check, no symlinked node_modules, fresh DB + migrate deploy + seed + prisma generate. Replaces the four env failures seen on 2026-09-02 (node 26, missing deps after a merge, stale DB without a migration, unseeded baseline).

### §7.9f mutation-first hand-off
Dev/Techlead ส่ง SHA ให้ PMO gate ได้ก็ต่อเมื่อรัน mutation ที่ปิด finding นั้นเองแล้วเห็นแดง — รายงาน "แก้แล้ว" ของ implementer ไม่ใช่หลักฐาน (#40 bypass คลาสเดียวกันรอด 4 รอบ ทุกรอบเจอด้วย mutation ไม่เคยเจอด้วยการอ่าน)

### §7.15 /v1 test paths
`/v1/*` mount ใต้ `/api` — เทสต้องยิง `/api/v1/...` ยิง `/v1/...` ตรงจะแขวนจน timeout ไม่ใช่ 404 (Dev3 #71, QA-2 slice 2 เจอทั้งคู่)

### §7.6d shared worktree cleanup
worktree ที่มี agent อื่น (implementer) ทำงานอยู่ ห้าม `git checkout -- <dir>` / `git stash` ทั้งไดเรกทอรี — revert เฉพาะไฟล์ที่ตัวเองแตะตอน mutation (#40: `checkout -- server/` ลบงาน implementer ที่ยังไม่ commit)

### §7.16 push after merge
PMO ต้อง publish approof/main ทันทีหลังทุก merge — main ค้าง local 51 commit ทำให้ Dev4 rebase บน base ที่ไม่มี slice 2 (2026-09-02)

### §7.14a post-merge suite log
PMO post-merge suite ต้องเก็บบรรทัด `✕` และบล็อก `●` (grep -E "^(FAIL|Tests:|Test Suites:)|✕|●") ไม่ grep ทิ้ง — ครั้งแรกเสียชื่อเทสที่แดงไป (ldapRoutesHttp)

### §7.9g trust by registry, not by property
การตรวจใดที่อ่าน property/ชื่อจากฟังก์ชันเพื่อตัดสินความน่าเชื่อถือ (`resolverName`, `fn.name`, `isApiKeyGuard`) ปลอมได้โดยคนที่เขียนฟังก์ชันนั้นเสมอ — ใช้สมาชิกภาพใน registry (WeakSet บน globalThis symbol) ที่ endpoint file ใส่เองไม่ได้ · เจอ pattern นี้ = finding ทันที ไม่ต้อง mutation ก่อน (#40 bypass 4/5/7)

§7.9f หลักฐาน: #40 task 1 เจอ bypass 8 ตัว — ทั้ง 8 เจอด้วย mutation, 0 ด้วยการอ่าน, 4 ตัวหลังเจอหลัง implementer รายงาน "แก้แล้ว" · shape/count guard (regex, registrations===N, skipped ว่าง) จับ "ของที่รู้จักหาย" ไม่จับ "ของที่ไม่รู้จักโผล่" — ต้องใช้ list ที่ production วนจริง (§7.9g)

### 7.9h เกณฑ์จบงาน guard/sweep = mutation ที่ทีมนึกออกแดงครบ + backlog ซื่อสัตย์

งานที่สร้าง "ตัวตรวจ" (sweep, completeness guard, registry) ไม่มีวันพิสูจน์ได้ว่า "ไม่มี bypass เหลือ" — #40 มี bypass 9 ครั้ง และ 3 ครั้งติดกันตัวตรวจใหม่ถูกเจาะทันทีที่เกิด (regex → AST → router walk → identity registry → AST completeness ทุกชั้นเจาะได้ที่ชั้นของมันเอง)

เกณฑ์รับงาน: (1) mutation ทุกตัวที่ Dev/QA/Techlead นึกออกแดง (2) surface ที่ยังเปิดอยู่ถูกบันทึกใน `residual-risks.md` โดยระบุว่าอะไรยังไม่กัน (3) ห้ามเขียนว่า "ปิดครบ" — เขียนว่า "ปิดที่รู้จัก N ตัว ณ SHA X"

เทส sweep/spoof ต้องเรียก predicate/registry ตัวจริง ห้าม parametrize classifier ให้ inject ได้ (`classifiers.isOrgResolver || isOrgResolver` = พิสูจน์ตัวปลอม ไม่ใช่ตัวจริง)

### 7.9i ตัวตรวจแบบ static: รูปที่ไม่รู้จัก = ล้มเหลว ไม่ใช่เพิกเฉย

collector/sweep ที่อ่าน source (AST/regex) ห้ามมี default "ไม่ตรงรูป = ข้าม" — #40 bypass #9–#12 (alias, suffix, declarator index, member access) เป็นคลาสเดียวกัน: collector รู้จัก import รูปหนึ่ง ของนอกรูปหลุด แก้ทีละรูปไม่จบ

กฎ: ประกาศรูปที่รับเป็น convention (คอมเมนต์ในไฟล์ที่ถูกบังคับ) แล้ว assert ว่าทุก require ในขอบเขต (เช่น `./endpoints/*` ใน `server/index.js`) ตรงรูปนั้น รูปอื่นแดงพร้อมบรรทัด + รูปที่รับ · fixture ทั้งสองทิศ ("รับ" / "ปฏิเสธ+เหตุผล") ครอบ bypass ที่เคยเจอ · ต้นทุน = convention บังคับในไฟล์เดียว ถูกกว่าไล่ตามรูป

#### 7.6c note — prisma client ฝัง path `.env` ของ worktree ที่ generate
generated client โหลด dotenv จาก path absolute ที่ฝังตอน `prisma generate` — hardlink/symlink `node_modules` ข้าม worktree จึงดึง `.env` ของ worktree ต้นทางเข้า `process.env` (#74 TL-2: `SIG_SALT` โผล่จาก `f40/server/.env`) · เทสที่คาดว่า key "หาย" ต้อง `delete process.env.KEY` ก่อนเรียก คืนค่าใน `finally` · gate worktree ของ PMO ต้อง `prisma generate` ในที่ของตัวเอง (wt-bootstrap ทำอยู่แล้ว)

### 7.1d เทสที่ขึ้นกับสถานะ server (extension/locale/version) ต้องรัน suite บนทั้งสองสถานะ
#74: QA-3 และ PMO gate เขียวเพราะ DB ของตัวเองบังเอิญมี extension ติดตั้งแล้ว; TL-2 บน DB สดพบ 3 เทสแดง · กฎ: เทสที่ assert สาขาซึ่งขึ้นกับสถานะ DB ต้องจัดสถานะเอง (`beforeAll` CREATE/DROP, `afterAll` คืน) และ reviewer ที่ probe สถานะพิเศษด้วยมือต้องรัน suite ทั้งบนสถานะนั้นและสถานะสด — probe ด้วยมือเห็นพฤติกรรมถูก ไม่ได้พิสูจน์ว่า suite จัดสถานะให้ตัวเอง

### 7.9j ด่านความปลอดภัยของ route ต้องตรวจ router ที่ประกอบแล้ว ไม่ใช่ซอร์ส
#40: AST/regex scan ของ `index.js` ตอบว่า "ไฟล์เขียนถูก convention ไหม" — inline `apiRouter.post(...)`, registrar นอก `./endpoints/`, แก้ list หลังประกาศ ผ่านหมด (TL-1 X1–X6) · ด่านหลักต้องเดิน `app._router.stack` recursive ของ router ที่ production ประกอบจริง แล้วยืนยัน gate ด้วย identity (WeakSet registry §7.9g) ทุก mutating route · scan ซอร์สเป็น diagnostic บอกตำแหน่งเท่านั้น · list ที่ production เดินต้อง `Object.freeze`

#### 7.9f evidence — #78 e52553fc7
ruling "ลบ `Object.fromEntries` filter" → implementer เปลี่ยนเป็น `Object.create(null)` + loop `managerAllowedFields.includes(key)` — พฤติกรรมเดิมทุกประการ (manager+unknown → 200 ไม่เขียน) · PMO grep `fromEntries` = 0 แล้วนับว่าผ่าน; Dev1 trace path จับได้ · บทเรียน: เงื่อนไขรับงานต้องเป็นพฤติกรรม (เทส manager+unknown → 400) ไม่ใช่การหายไปของชื่อ symbol

### 7.6e mutation backup ต้องเก็บ path เต็ม ไม่ใช่ basename
#87: backup 4 ไฟล์ลง /tmp ด้วย basename — `utils/helpers/index.js` กับ `utils/doctor/index.js` ชนกัน restore เขียน doctor ทับ helpers source edit หายทั้งหมด (โผล่เป็น 27 แดง โชคดีที่ไม่เงียบ) · ใช้ `git stash` / `git diff > patch` / path เต็ม (`tr / _`) เท่านั้น · restore ที่ "ดูเหมือนสำเร็จ" คือ failure mode

#### 7.9f evidence — #78 follow-up 034243d1: drift test ที่เทียบตัวเอง
`forbidden = recognized − allowed; expect(allowed ∪ forbidden).toEqual(recognized)` จริงโดยนิยาม ไม่เคยถาม runtime — ลบ `multi_user_mode` จาก protectedFields ยังเขียว · แก้เป็นเรียก `narrowManagerSystemPreferences` จริงด้วย actor ที่ถูกปฏิเสธ ทีละ key แล้ว mutation ถอด union จาก helper → แดง · กฎ: เทส drift/relation ต้องมีอย่างน้อยหนึ่งฝั่งที่มาจากการ**รันของจริง** ไม่ใช่สูตรเดียวกันสองครั้ง

### 7.9k mutation report ต้องบันทึก `git rev-parse HEAD` + baseline count ก่อน mutate
#40: QA-2 รายงาน 42/42 บน revision ที่ label ว่า a2bbb0de แต่จริงเป็นตัวก่อน; Dev2 เจอแบบเดียวกันที่ 9d94919 · ทุกแถวใน mutation table ต้องมี SHA ที่วัดจริง + baseline count ก่อนแก้ ไม่งั้นแถวนั้นไม่นับ (§7.9f attribution)

### 7.9l mutation harness ต้องพิสูจน์ว่า mutation ลงจริงและ suite รันจริง
#40 TL-2: inject anchor ที่ไม่ตรง (`= [` vs `Object.freeze([`) = replace เงียบ; probe อ้าง symbol นอก scope = ReferenceError ตอน import → `Tests: 0 total` ซึ่งใต้ `grep ^Tests:` ดูเหมือน "จับได้" · กฎ: ทุก mutation row ต้อง (1) assert diff ไม่ว่าง (2) assert `Tests: N total` ของ run นั้น ≥ baseline − expected-failures (หรือ `Test Suites: 0 failed`) ก่อนนับว่า caught · `0 total` = harness พัง ไม่ใช่ finding (คู่กับ §7.9k)

#### 7.14c partial gate ต้องรัน sweep suites เสมอ
#80 gate รันเฉพาะ contract suites (§7.14 partial) → merge แล้ว `updateSettingsReturns` sweep (#65) แดงบน main (`endpoints/mailer.js:110/171` ทิ้ง return) · กฎ: partial gate ต้องเพิ่ม sweep ที่เดินทั้ง tree เสมอ — `updateSettingsReturns`, `routeGateSweep`, `apiRouteAuthSweep`, `managerAllowedFieldsDrift`, `providerDocIdCallSites` (ลิสต์ใน `.infi/sweeps.txt` ต่อไป)

#### 7.9f evidence — #84 f309f1247: source-scan comparison with unbounded search
gate-equality test did `source.slice(at).match(/requirePermission/)` — deleting the DELETE route's middleware line made both routes resolve to the same `requirePermission` at line 764 (update-env's), so "equal" was trivially true. QA-3 proved it by running the extractor: `DELETE foundAtLine=764, POST foundAtLine=764`. Fixed by bounding the slice to the route's own registration block (c22939503). Rule: any source-scan that compares two sites must bound each search to its own block and assert a match exists inside that block.

### §7.11a Risk tiers (2026-09-02, user ruling)
PMO classifies at contract time. `auth` = touches auth/permission/schema/secrets or any unauthenticated surface (e.g. `/metrics`, CLI bundle): full §7.11. `plain` = gate PASS + Techlead pre-read, merge without waiting verdicts. Dev never self-classifies; #94 and #102 looked plain and were not.

### §7.17 Reject-lesson log
Every reviewer rejection names a class; PMO repeats it in the next dispatch to all devs. Log:
- **Coincidental fixture** (#84 unbounded scan, #94 dotted host, #40 absent-id oracle, #49 both stamps move together): a test whose fixture happens to avoid the bug. Reviewer names the negative fixture in pre-read; dev proves red on it.
- **Self-satisfying assertion** (#78, #94 F2, #40 F1): assertion true for a reason unrelated to the code under test. Every mutation must red a *named* test.
- **Fail-open default** (#40 getWithUser(null)): missing id widens a filter. Guard before lookup, test that lookup is not called.
- **Reuse ruling without reading** (#96): "reuse X" when X answers a different question. Techlead confirms structure before dispatch.
- **Harness silence** (§7.9l, #40 `0 total`, TL-2 wrong path 76/76): a suite that never ran reports green. Always confirm the suite count moved.
- **Merge verified by title, not content** (#49 cb0e3b75e: merge commit landed docs+tests, zero source, because a prior revert of the same ancestor won). After every merge: `git show HEAD:<file> | grep -c <new symbol>` on one production file, and run the issue's contract on main before closing.
- **Fail-direction ruling from name, not catch branch** (#112: "use User.count() not isConfirmedSingleUser" — count() returns 0 on DB error = open; isConfirmedSingleUser returns false = closed). Before ruling on which helper gates a route, read its catch branch.
- **Hostile payload placed where it cannot show** (#108/#116, Dev4 self-caught): a "leak" test whose injected value is never rendered passes both with and without the fix. Place the payload on the path the vulnerable code actually carries (form state / POST body), and prove red by reverting the fix.
- **Red under concurrent local runs is an environment claim** (#106/#116): a suite that fails while other jest runs share the DB is not a code failure until a serial run repeats it. Check `pg_stat_activity` before triage.
- **DOM test red for the wrong reason: i18n** (#40 t4): without i18n init, components render the translation key, so a text query for the English string fails and looks like a broken component. Query by key or role, and comment why.
- **Negative DOM test passes for free when the selector finds nothing** (#40 t4 SearchBox: icon-only control, text in data-tooltip-content). Every "hidden" assertion needs a positive control proving the selector locates the control when shown.
- **Converted site with no test of its own** (#40 t4 ToolsMenu): reverting a converted site left the suite green because only a neighbour was tested. Every converted site gets its own test; prove by reverting that site alone.
- **`getByLabelText` that fails is an accessibility report** (#108 label hint, #124 model-picker button): when a test cannot locate a control by its accessible name, a screen reader cannot either. Fix the markup (htmlFor/id, aria-label), do not work around the query.
- **Sweep matches text, not calls** (#40 t4): `source.includes("updateSystemPreferences(")` flagged two files whose only match was an explanatory comment. A sweep must strip comments and skip test files, or it teaches false allowlist entries. Fix the sweep, never pad the allowlist.
- **PMO assigned a lane from filenames in the diff** (#40 t4): both reds were sent to the Memories owner because the failing lines named Memories files; the causes were a sweep false-positive and a mock in a different test. Read the cause before naming the owner.
- **Green report, non-zero exit** (#40 t4): a missing mock method called from an unawaited effect surfaces as an unhandled rejection; vitest prints every test as passed and exits 1. Announce a SHA only after checking the exit code, never the pass count.
- **Gateway with no authorization** (#113): a new exported, transactional `addGroupMember` looked like the safe path but checked only that an actor existed; since group membership expands grants, any caller could hand out super_admin. A function that mutates a grant path carries the same set-containment check as `grantRole`, in the same commit that creates it.
- **Source assertion matches its own comment** (#40 t4): `expect(source).toMatch(/visible && can(...)/)` stayed green after the code was mutated because a comment spelled the same phrase. Any source-text guard strips comments first, or it pins prose, not code. Third occurrence of the text-not-code class today.
- **Helper file inside `__tests__` is an empty suite** (#123): `assignableRolesSession.js` had 0 tests and failed the full run; the gate only ran contract paths. Helpers live in `__testHelpers__` or `__tests__/support/`; gates that add files under `__tests__` run the directory, not just the contract.
- **"Nothing to contain" is not "nothing to lose"** (#113): an early return when a group holds zero role grants skipped the guard for deny-only groups, whose power lives in `document_acl`, not `principal_role_grants`. A short-circuit on one table must enumerate every table that gives the principal effect.
- **Reachability retraction from seed data alone** (#113): the "unreachable today" call was made from seeds and callers; QA-1 reached the path through the exported gateway in one probe. A finding is downgraded only after a probe fails to reach it, not after a grep shows no caller.
- **Stability asserted inside one state** (#124): a test that a label stays constant sampled twice during the same async fallback window, so a value-derived label looked constant and the promised mutant survived. Asserting stability requires observing at a moment the value could have changed (after the async value is visibly on screen).
- **Attribute-equality test passes with no attribute** (#124): `getAttribute("aria-label")` compared across two renders is `null === null` when the attribute is deleted, and a name matcher satisfied by visible fallback text never reads the label. A stability test asserts the value is non-empty first, and queries the accessible name after the async state that changes it has resolved.
- **First mutation is always "delete the line the diff added"** (#124, TL-1): the reviewer tested a clever mutant (`aria-label={modelName}`) and passed the SHA; the obvious one (remove the attribute) survived. Run the deletion mutant before any other.
- **Assert in a state where only the named property can satisfy it** (#124, 3rd in this component group): `getByRole(name)` falls back to text content, and the fallback text equalled the intended label, so a deleted `aria-label` still matched. Where a query has a documented fallback, assert the mechanism (`getAttribute`) directly, after the async state resolves.
- **Extracting a gate drops the call-site guard** (#126 s1): render tests cover the component; nothing imported the page, so "never call the gate" survived. Removing a source guard needs a replacement that covers the same claim (the call site), not a different one (the component).
- **Reviewer fixtures fired through the object under review, not its siblings** (#119, TL-2): all 9 fixtures went via `apiRouter`; `app._router` was never probed. Enumerate every object that reaches the same surface before passing.
- **Character class written with literal glyphs becomes a range** (#120): `[ -　]` (space, hyphen, ideographic space) is the range U+0020–U+3000, swallowing `.` `/` `:` and all ASCII. Multi-script separator classes use escape sequences, and a test asserts on the compiled pattern that it is a set.
- **Delete-line-first applies to what the diff removed** (#126 s1, TL-1): a diff that deletes a guard is reviewed by removing what that guard protected (the gate call) and checking what goes red. Nothing did. "No source assertion left" is not a virtue when the render test covers a different claim.
- **Green report, non-zero exit — second occurrence** (#121, same day as #40 t4): dev announced 105/105 without the exit code; 26 unhandled rejections from a mock missing `fetchSupportEmail`/`fetchCustomFooterIcons`. Every dispatch now says: announce a SHA only with `yarn test; echo $?` = 0. A mock of `@/models/system` must cover every method the mounted tree calls, not just the ones the test names.
- **Client test mocks the hook, server never changed** (#121, TL-1 F-A): the sidebar asked `can("system.read")` and the test's mocked capability map answered yes, but `ORG_CAPABILITIES` on the server never got the key, so production hides the entries from everyone. A new capability key needs a server-side test that it is in the map, in the same commit as the first client caller.
- **PMO ruling from symmetry, not from log contents** (#120): "ASCII comma IN, symmetric with fullwidth" was ruled without asking what audit logs actually contain; CSV and id lists are everywhere and would have been redacted as cards. A separator ruling is decided by measured false positives on real log shapes, and needs a TL read before dispatch (CLAUDE.md rule).
- **Fixture refused for the wrong reason** (#128, Dev3 self-caught): a scope-clause test granted a role the actor did not contain, so containment refused it before scope ran; and a role wholly inside BASELINE_GRANTABLE is grantable by anyone, so its test is green with or without the fix. Pick the fixture so the clause under test is the only one that can refuse, and prove it with the mutant.
- **Mutation that never applied reads as a survivor** (#119, Dev5): a `str.replace` with wrong indentation matched nothing, the file was unchanged, and "all green" was almost reported as a surviving mutant. Grep the mutated line before trusting any mutation result. Also: never probe `app.router` on express 4 (getter throws deprecation); use `_router`.
- **Unbounded slice on a missing delimiter** (#127, repeat of #84): `block.slice(0, block.indexOf(delim))` with no match gives `-1` and reads the rest of the file, so a source guard fails open when formatting changes. Assert the delimiter was found before slicing.
- **Assertion input built by code that degrades instead of failing** (#127, Dev4): the assertion ran in the right state, but the slice that built its input silently widened on a missing delimiter. The code that constructs an assertion's input must fail loudly, not degrade.
- **Over-strip control that never reaches the strip** (#131, Dev5): every over-strip control used a value with no PII, which is returned verbatim regardless of class width, so `\p{Mn}` (stripping Thai tone marks) survived. A width control must place the legitimate character beside a real redaction, the only layout where class width is observable.
- **Fixture sits where two guards agree** (#133, Dev3 self-caught, 2nd time after #128): a small-org test at 33% attrition was below the ratio threshold anyway, so removing the FLOOR arm survived. A test for one arm of `A && B` must place the fixture where only that arm decides.
- **Offset map is a lookup table, not arithmetic** (#131, TL-2 reversal): per-match strip was first refused because computed offsets drift by one per removed codepoint; `origin[i]` recording each surviving char's real index has nothing to drift. Mixing code units and code points in that table breaks at surrogate pairs — fixture with a non-BMP Cf (U+13430) is mandatory.
- **Guard covers one output of a two-output plan** (#133): the scale guard counted deactivations only; a narrowed-scope snapshot with all users present but empty department_ids removed every membership with `refused: false`. Every destructive output list of a plan needs its own guard and its own "nobody left, everything else changed" fixture.
- **Non-BMP fixture must keep an astral char that survives** (#131, Dev5): a fixture whose only astral char is the one being stripped cannot distinguish a code-point map from a code-unit map; surviving astral content before the match is what shifts the cut.
- **Version number reuse after a sequence rewind** (O3, TL-1): `FilterCache` compares `policyVersion === head`; a restore that rewinds the autoincrement re-issues the same numbers for a different policy state, so a warm pre-restore cache entry becomes fresh again once the sequence catches up. A single bump after restore only narrows the window; restore must `setval` the sequence above the highest number ever issued.

- **#136 / TL-2 — lane-full is a scheduling problem, not a structural reason.** Do not pick the code shape (export a private invariant half) because the owning file's lane is busy. Reorder slices instead. `bumpVersion` stays private; `offboardUser` lives in policyRepository. `change_type` answers "what changed", never "why" — "why" is the audit event.
- **V8 / TL-2 — count from the right base.** `grep -v '?'` and `grep -v style` dropped every ternary and inline style, so "10 layout sites" was a filter artifact, not a measurement. Before reporting a count, print what the filter removed. Also: 52 of 78 sites were one copied expression — classify by distinct expression before calling something "N pending decisions".
- **#121 / Dev4 + QA-3 — a test that mocks the layer the bug lives in cannot witness the bug.** F-A was declared fixed on a green frontend suite whose `useCapabilities` mock supplied the missing capabilities by fiat. When the fix is in layer X, at least one test must run through real layer X (here: real `ORG_CAPABILITIES`), and a reviewer must verify the fix by the set-intersection, not by reading the diff.
- **#134 / Dev3 — a prescribed witness can pass for a reason unrelated to what it names.** Pre-read F1 said "tx-wrapped → one policy_versions row"; measured, both shapes give 2 rows. Before writing a fixture from a reviewer's prescription, measure the premise on a real DB; if the mutant survives both shapes, record it as an unkillable survivor (§7.9) and find the witness that measures the real effect (here: rollback scope, via a conflict fixture). Same class as #128 RF-2, #133 D4/F2.
- **#130 / TL-2 — a limitation written in a comment becomes a fact nobody re-tests.** "Nothing behavioural can catch it" was false: capture the `afterAll` callback by swapping `global.afterAll` during require, invoke it, assert `$disconnect` called. Before accepting "cannot be tested in-process", try to seize the callback/handler directly. Same class as #119 F4.
- **#121 / PMO — commented-code detector fires on prose comments carrying backticked calls.** Prose false positive → `.infi/checkignore`, not a code change.
- **#134 / TL-1 — a comment that names a mutant it does not kill is a §7.17 defect even when the test is worth keeping.** RF-2 called itself "the F1 witness" after measurement showed both shapes produce the same row count. Fix the comment to what the test actually pins (2 bumps + 2 outbox + membership exists), not what the pre-read hoped.
- **S4b slice 3 / TL-1 — do not rewrite a lock in app code.** Lock-row + heartbeat withdrawn: expiry, staleness, and dead-owner rules are correctness questions the DB does not help with. Use `pg_advisory_xact_lock` inside a short claim transaction that writes the checkpoint `running` row and commits; concurrency is decided by that row's status + timestamp. Crashed owner leaves a visible `running` row, not an invisible lock.
- **#136 / Dev5 — a spy on the root prisma client never fires for writes made on a transaction client.** `jest.spyOn(prisma.api_keys, "updateMany")` was silent because the write ran on the `tx` object; use `prisma.$use` middleware (applies to every derived client) to induce failure. Also: "in the same transaction" is only a claim until an atomicity fixture (fail the second write, assert the first did not land) turns the out-of-tx mutant red.
- **#136 / Dev5 — 29 reds from an unmigrated DB are a harness fault, not a diff fault.** Before reporting broad failures, confirm the DB is migrated+seeded; note the false run in the ledger as a baseline note.
- **#134 / PMO — the commented-code detector treats a `#NNN` inside a string as a comment start.** `describe("#134 R1: …", () => {` is flagged as commented code. Prose/string false positive → `.infi/checkignore`; do not rename tests to dodge the scanner.
- **#136 / QA-2 + TL-2 — an edge-triggered sweep at one write path is not enforcement.** `isSuspending` fires only on the 0→1 transition inside `User.update`; `User._update`, a re-suspend, or a key minted for an already-suspended owner all bypass it. A refusal must live where the credential is read (resolveActor), or every future writer to the column silently reopens the hole. Extension keys already do this right; API keys did not.
- **#138 / TL-1 — a rule that references an unbounded quantity is not a rule.** "Lease > longest single driver-call stall" was issued before checking the stall was bounded (Lark fetch had no timeout; Retry-After unclamped). Before deriving a number from a property, measure that the property has a ceiling. Reuse in-house precedent (OidcIdentityProvider DEFAULT_TIMEOUT_MS = 10_000) rather than inventing a new one.
- **#132 / TL-2 — a page that reads with one action and writes with another must be guarded by the action that makes the page work.** DefaultSystemPrompt and AdminLogs read via system.read but write via settings.write / system.write; moving them to a system.read guard admits users who cannot edit — #127 in reverse. Verify both the GET and the mutation route before assigning a guard, even when today's holders make the outcome coincide.
- **#132 / TL-2 — write tests against the capability, not the role.** "non-holder of system.read is refused" stays true after #137 grants setup_admin; "setup_admin is refused" goes red and looks like #137 broke it.
- **V8 / TL-1 — a magic calc is usually compensating a sibling rule.** `calc(100% - 32px)` = `md:my-[16px]` × 2 on the same element; the breakpoint must match the margin's breakpoint. State the relationship in the contract and at one representative site.
- **#132 / Dev4 — a full-line-only comment strip lets a guard name in a TRAILING comment satisfy a source assertion.** Strip trailing `//` too, assert the file has no `//` inside string literals, and assert the extracted block spans exactly one route. Found by running P5, not by reading the regex. Brace-matched extraction survives prettier reflow where offset guards do not.
- **#138 / Dev3 — bounding one call site leaves the earlier one unbounded.** `_tenantAccessToken` runs before any page fetch; a timeout on `_page` alone looks complete in review and hangs identically in production. When adding a bound, enumerate every outbound call on the path.
- **#138 / Dev3 — a "drop" fixture is green against a driver with no timeout.** Only a server that ACCEPTS and never answers reproduces the stall; assert the bound both ways (under a ceiling AND over a floor, so a driver that gives up after one attempt does not pass by losing retries).
- **#136 / TL-2 — do not add a discriminator for a second writer that does not exist.** `revokedAt` has one writer (the sweep); human revocation deletes the row. A tag to separate two sources when there is one is debt paid early. Revocation timestamps are historical facts, not state flags: never clear them on un-suspend.
- **#137 / TL-1 — a new permission row needs its own grant; earlier CROSS JOIN migrations only covered rows that existed then.** Pattern: 20260902040000..043000, 20260902050000:18-22. Also: name a split action after what it destroys (`audit.purge`), not the endpoint hosting it. Blast radius of a grant is the route table, not the frontend call-site count.
- **#136 / Dev5 — a new dependency inside an injectable seam breaks every narrow stub silently, and a throw is not fail-closed.** Adding `db.users.findUnique` inside resolveActor's api-key branch threw TypeError through 7 suites whose stubs lacked it. Rule: a new read inside an injected dependency must degrade to REFUSE (`unreadable`), and the stubs that declare the seam's contract (`__testHelpers__/grantStore.js`) get updated in the same SHA.
- **#138 / Dev3 — `AbortSignal.timeout` counts from creation; hoisting it above a retry loop gives later attempts no time.** Create a fresh signal per attempt. And distinguish caller cancel from timeout by `signal?.aborted` (whose signal fired), not by the error — a cancel must not be retried, a timeout may be.
- **#136 / TL-2 — a change that makes a pre-existing reversible bug irreversible owns that bug.** `castColumnValue` (`Number(Boolean(v))`) mapped `"0"` → 1; before #136 that was a wrong column an admin could flip back, after #136 (permanent revocation) an un-suspend request carrying `"0"` revokes every key for good. When adding an irreversible side effect, audit every writer of the trigger column for coercion.
- **#136 / TL-2 — a ledger claim that a mutant reds a named test must be run, not reasoned.** "R3 makes CONTROL red" was false: jest runs `it` in declaration order and CONTROL minted its key after the only suspend, so it was never in the sweep's scope.
- **#136 / TL-2 — validate the id before the repository call, or a no-op becomes a version bump.** Nonexistent `:groupId` → guard finds empty permission set → returns early → bumpVersion writes → deleteMany no-op → 200. Any user.manage holder can churn policy versions and invalidate org-wide cache with a random id.
- **#137 / Dev1 — a permission gate called inside a wrapper function is invisible to route-table walks.** `GET /system/preflight` (system.js:415) invokes requirePermission inside gateUnlessPreUser, so `handle.action` is absent and the mounted-route count under-reports (21 vs 22 call sites). Reconcile call-site vs route-table counts by naming the wrapped ones, and treat them as a sweep gap.
- **#137 / TL-1 — a grant assembled from "which menu entries came back" confers unrelated authority.** `model-router.write` sets which provider receives each chat = a chat-read path for a role documented as "reads nobody's chats". Twice in one issue (audit.purge, model-router). Derive grants from what the role must DO, then check each action's blast radius on the route table; never from the sidebar diff.
- **#137 / TL-1 — a sidebar entry whose capability is not in ORG_CAPABILITIES vanishes for super_admin too.** Re-gating an entry is two lines and one is server-side (system.js:115 list). Residual: mcp-server.*, agent-flow.*, scheduled-job.* are not in the list; audit the whole sidebar once.
- **O3 / TL-2 — an exact-count oracle is red on a lagging DB and green-for-the-wrong-reason after a coincidental add.** Derive N from the DB under test (is_identity OR nextval default), assert enumerate==tested==N, keep only a sanity floor as a constant. Fixture must cover SERIAL and IDENTITY.
- **O3 / TL-2 — the outbox publishes in the same tx as bumpVersion; a restore that rolls back pg but not the event leaves every cache chasing a phantom version.** Restore-to-fresh-then-swap is the only honest shape; assert no policy.changed escapes a failed restore.
