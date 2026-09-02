# Recon — O5b: diagnostic bundle (`doctor --bundle`)

Base: `approof/main` after O5a (#90) merged. Rulings from `docs/superpowers/recon/o5-diagnostics.md`:
CLI first (no UI, no mockup), permission `diagnostics.export` granted to super_admin only,
migration slot 100000 approved and to be announced on the issue, allowlist + pattern scan reusing
`stripUrlCredentials`/`maskSecretValues`, threat model written at the head of the file.

## 0. The threat model, first, because it decides everything else

**The bundle is a file, and files get shared.** It will be attached to a GitHub issue, dropped in
a support email, pasted into a chat. That is the threat — not an attacker breaching the server.
An operator who generates one is, by intent, about to hand it to a stranger.

Two consequences the design has to carry:

- Redaction happens **on assembly**, not on delivery. There is no second chance once the file
  exists on disk.
- The bar is not "no secret an attacker could use". It is "nothing the operator would be upset to
  find in a public issue" — which includes customer names, document filenames, and user emails,
  none of which are secrets.

## 1. What the tree already solved, and must not be re-solved

Three precedents, each written after a real regression. The bundle reuses all three rather than
writing a fourth thing that does 80% of the job.

**`maskSecretValues` / `maskOneValue`** (`utils/helpers/updateENV.js:1685-1705`). Masks by
consulting `KEY_MAPPING[key].secret` across 214 declared keys, and **treats an undeclared key as a
secret**. `"url"`-typed values get `stripUrlCredentials` rather than a full mask, so an operator
still recognises the endpoint they configured.

**`utils/events/redaction.js`**. The audit sink's two-guard shape, and its header states the
principle: *"A denylist protects against the payloads someone thought of; an allowlist protects
against the ones they did not."* The regression that forced it: `models/user.js` guarded with a
hardcoded `sensitiveFields=["password"]` at **one** call site, so a second call site passing a
password would have stored it verbatim.

Its `PATTERNS` list (`:62`) is directly reusable and is more complete than anything I would write
from scratch: Thai national ID before credit card (so a 13-digit ID is not swallowed), email,
Thai phone, and the whole `apw-*-` credential family — deliberately matching the FAMILY rather
than a prefix list, because `apw-tat-` was missed by an explicit three-prefix alternation and
caught only in review.

`scrubValue` (`:125`) walks strings at every depth with a depth limit. `redactEventData` exports
what the bundle needs.

**#74's doctor.** `runChecks` already produces the machine-readable checklist an operator would
otherwise be asked to paste by hand, and its `detail` strings are written for exactly this
audience.

## 2. What goes in

The test of each item is: *would its absence mean a second round-trip with the operator?*

| section | source | notes |
|---|---|---|
| versions | `package.json`, `process.version`, `process.platform/arch` | |
| doctor checklist | `utils/doctor` `runChecks()` | scrubbed like every other section — see the `updated` note below |
| migration state | `_prisma_migrations` — name, `applied_steps_count`, `finished_at`, `rolled_back_at` | the failed-migration state §7.13 exists for is invisible without this |
| configuration shape | env allowlist, below | which provider, never which key |
| counts | `event_logs` grouped by `event`, user/workspace/document totals | **counts, never rows** |
| resources | `process.memoryUsage()`, uptime, `os.totalmem`, cpu count | |

Two things pulled deliberately **out**:

- **`event_logs.metadata` rows.** Redacted on write already, but they are still the record of what
  every actor did, and `audit.read` is super_admin-only because "export is bulk egress of the
  highest-value data on the instance" (`prisma/seeds/permissions.js:95`). Summary counts by
  `event` answer "is anything failing" without shipping the trail.
- **Recent error text / stack traces.** The most tempting item and the least safe: a stack trace
  can carry a query string with a token, a filename with a customer's name, or a prompt fragment.
  If a later ruling wants them, they go through `scrubValue` like everything else — but the honest
  default is out.

> **updated (TL-1 finding F4):** "already redacted by construction" was wrong, and is corrected in
> the table above. A check's `detail` string quotes what it FOUND — a connection string, a
> filesystem path, a locale name — so it is built from exactly the environment every other section
> is redacted for. `runChecks()` output goes through `scrubValue` like everything else. Relatedly,
> `collectDatabase` builds its own connection line from `stripUrlCredentials` rather than reusing
> the doctor's `maskUrl`, which keeps the username: right for a checklist on the operator's own
> terminal, wrong for a file headed to a public issue, where a database username and an internal
> hostname match no pattern and nothing downstream would catch them.

## 3. Environment: an allowlist, and why `maskSecretValues` alone is not enough

`maskSecretValues` over all 214 keys is *safe* — undeclared keys mask fully. But the bundle's job
is to be **useful**, and a file of 214 rows of `**********` is not. The pressure will be to unmask
the obviously-safe ones, and that pressure is how a denylist forms.

So: an **explicit allowlist of env keys**, each present because someone decided it is diagnostic.
Roughly: `NODE_ENV`, `STORAGE_DIR`, `VECTOR_DB`, `LLM_PROVIDER`, `EMBEDDING_ENGINE`,
`SERVER_PORT`, `ENABLE_HTTPS`, `DISABLE_TELEMETRY`, `IP_ALLOWLIST` — and for every one of them the
question asked at review is "why does the operator's problem need this".

**`DATABASE_URL` is the interesting case.** Host and database name are genuinely diagnostic; the
password is not. `stripUrlCredentials` (`updateENV.js:1713`) already performs exactly this
transformation and falls back to a full mask when the value does not parse — an unrecognised shape
in an endpoint field might contain anything. Reuse it. Do not write a second one.

Every value, allowlisted or not, then goes through `scrubValue`. Belt and braces, for the same
reason `redaction.js` runs both: an allowlisted key still carries free text.

## 4. The permission, and the migration

> **updated (PMO ruling 1, after this recon merged): this issue is CLI only and carries no
> migration.** `diagnostics.export` and the slot-100000 timestamp move to O5b-ui, where a request
> with an actor actually exists to check them. Reason: a permission that nothing in the same issue
> checks is an inert guard — the #80 family, where a row exists in the vocabulary and every code
> path reaches the feature without consulting it, so the guard reads as protection in review while
> protecting nothing. No slot is reserved now. The paragraphs below are kept as the reasoning
> O5b-ui inherits, not as this issue's scope.

`diagnostics.export`, granted to super_admin alone — the same reasoning and the same shape as
`audit.read` (migration `20260902050000`).

`system.read` is explicitly too weak: `permissions.js:59` says a key that may read system status
must not thereby read provider credentials, which is precisely the line a bundle crosses.

**Migration slot 100000 is Dev5's** (already used by `20260902100000` and `20260902101000`); the
next free timestamp in that slot takes the vocabulary row and the super_admin grant — in O5b-ui,
not here, and not reserved until then.

**The CLI has no session.** `docker compose run --rm anything-llm doctor --bundle` runs as the
container, with no HTTP request and no actor. That is what forces the split above: for the CLI the
control is that you already have shell access to the container, which is strictly more than the
bundle grants.

## 5. Delivery

`doctor --bundle` writes JSON to stdout, so it composes:
`docker compose run --rm anything-llm doctor --bundle > bundle.json`. #74's entrypoint dispatch
already has the `case "${1:-serve}"` this hangs off.

**stdout, not a file inside the container** — a file would need a volume mount to retrieve and
would leave the bundle on the container filesystem afterwards.

**One caveat that must be in the issue:** the doctor's own human-readable output goes to stdout
today. `--bundle` must emit JSON *only*, or the redirect above produces something that is not JSON.
Diagnostics about the bundling itself go to stderr.

> **updated (PMO ruling 2): confirmed as stated.** `--bundle` puts JSON on stdout and nothing else;
> the checklist goes to stderr. The test asserts it by parsing the *entire* stdout as JSON rather
> than searching it for a `{`, so a stray log line fails rather than being tolerated.

## 6. Tests

The one that matters: **seed a known secret into every reachable source, then assert it appears
nowhere in the serialised bundle.** Not per-field assertions — a scan of the whole JSON string, so
a field added later without redaction fails the existing test rather than needing a new one. This
is the shape `envDumpGuardHttp.test.js` already uses.

Sources to seed: an env value with a password-bearing `DATABASE_URL`, an env key not in the
allowlist, an `apw-key-…` credential, an email, a Thai national ID.

Plus:
- the allowlist is a frozen constant, and every key in it is `secret: false` in `KEY_MAPPING` or
  explicitly justified
- `event_logs` contributes counts, never row content — assert no `metadata` value reaches the file
- `--bundle` emits parseable JSON on stdout with nothing else interleaved
- the bundle includes the doctor checklist, so an operator's paste answers the preflight questions

## 7. Also in this commit (PMO)

`__tests__/scripts/doctor.test.js`'s header does not say that its database-backed tests want a
PostgreSQL with pgvector available; TL-2 lost ten minutes to it. One paragraph, stating what the
suite needs and that a stock `postgres:16` skips those blocks rather than failing.

## Scope

**In:** `utils/diagnostics/` (assembly + allowlist), the `--bundle` dispatch, the tests above, and
the `doctor.test.js` header note.

**Out:** the `diagnostics.export` permission, its migration and seed sync, and the slot reservation
— all O5b-ui (ruling 1, §4); the UI download (O5b-ui, needs a mockup); shipping the bundle
anywhere; log ingestion; `event_logs` row content; counter wiring (O5a-wire).
