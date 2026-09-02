# Techlead-1 — #94 O5b pre-read (`doctor --bundle`)

Read: recon `docs/superpowers/recon/o5b-diagnostic-bundle.md` + plan
`server/docs/superpowers/plans/o5b-diagnostic-bundle.md`, both at `8a6b3118a`, against the
helpers they reuse on `approof/main`. Probes are in-process `node -e` against the real
modules; no suite run (§7.14).

The threat model is right and it is at the top, which is where it belongs. Ruling 1 (drop
the inert permission to O5b-ui) is the correct call for the reason given. Four findings
below, all reachable before Dev5's SHA.

## FINDING-1 (blocking, cheap) — the two helpers the plan reuses are not exported

Measured on `approof/main`:

```
updateENV.js exports : supportedVectorDB, KEY_MAPPING, loadStoredCredentials,
                       clearStoredCredential, INSTANCE_AUTH_KEYS, ENV_KEY_PATTERN,
                       dumpENV, persistCredential, updateENV, writeEnvFileAtomic,
                       maskSecretValues
  -> stripUrlCredentials : undefined

redaction.js exports : redactEventData, ALLOWED_KEYS, PATTERNS, PII_CHANGE_FIELDS
  -> scrubValue          : undefined
```

Plan task 1 calls both by name. Neither is reachable. This is a five-minute fix (add to
`module.exports`), but it must be **that** fix and not the alternative one, which is why it
is worth naming before the SHA: the tempting substitute is to reach for what *is* exported,
and both substitutes are wrong.

- `maskSecretValues` is not a substitute for `stripUrlCredentials`. It keys on
  `KEY_MAPPING[key]` where `key` is the **setting name** (`VectorDB`), not the env key
  (`VECTOR_DB`) — probed: `KEY_MAPPING["DATABASE_URL"]`, `["NODE_ENV"]`, `["VECTOR_DB"]`
  are all `undefined`. Feed it env keys and every value comes back `**********`, because
  an undeclared key is treated as a secret. The bundle would be uniformly masked and
  useless, and the pressure the recon predicts ("the pressure will be to unmask the
  obviously-safe ones") would arrive on day one.
- `redactEventData` is not a substitute for `scrubValue`. It applies `ALLOWED_KEYS` (44
  audit-event field names) before scrubbing. Probed on a bundle-shaped object:

  ```
  redactEventData({versions, env, checks, counts}).data  ===  {"_droppedKeyCount": 4}
  ```

  It deletes the entire bundle. `scrubValue` is the pattern scan alone, which is what task 1
  actually describes.

## FINDING-2 — the allowlist can be derived only for 4 of ~10 keys; say which half is which

The recon proposes ~9 env keys. Probed each against `KEY_MAPPING` by reverse `envKey` lookup:

| key | in `KEY_MAPPING` | `secret` |
|---|---|---|
| `VECTOR_DB` | yes (`VectorDB`) | `false` |
| `LLM_PROVIDER` | yes (`LLMProvider`) | `false` |
| `EMBEDDING_ENGINE` | yes (`EmbeddingEngine`) | `false` |
| `DISABLE_TELEMETRY` | yes (`DisableTelemetry`) | `false` |
| `NODE_ENV` | **no** | — |
| `STORAGE_DIR` | **no** | — |
| `SERVER_PORT` | **no** | — |
| `ENABLE_HTTPS` | **no** | — |
| `IP_ALLOWLIST` | **no** | — |
| `DATABASE_URL` | **no** | — |

So plan task 3's assertion "no allowlisted key is `secret: true` in `KEY_MAPPING`" is, for
six of ten entries, an assertion about a key the table has never heard of — it passes
because the lookup is `undefined`, not because anything was checked. **That is an assertion
that proves its own formula**, the #78 shape.

The fix is not to drop the assertion but to split the allowlist so the derived half is
actually derived and the undeclared half is visibly a human decision:

```js
// Every entry declared secret:false in KEY_MAPPING. The test drives the real table,
// so a key reclassified as secret later fails here instead of leaking.
const DERIVED = Object.freeze(["VECTOR_DB", "LLM_PROVIDER", "EMBEDDING_ENGINE", "DISABLE_TELEMETRY"]);
// Not in KEY_MAPPING at all: process-level configuration nobody sets through the UI.
// Each one carries the reason it is diagnostic, because nothing else vouches for it.
const UNDECLARED = Object.freeze({
  NODE_ENV: "production vs development changes half the doctor's answers",
  STORAGE_DIR: "a wrong path is the most common install failure",
  ...
});
```
and assert, for `DERIVED`, that every entry **resolves** in `KEY_MAPPING` (not just that it
is not `secret:true`) and is `secret:false`; for `UNDECLARED`, that every entry has a
non-empty reason and is absent from `KEY_MAPPING` — so a key that later *gains* a
`KEY_MAPPING` entry as a secret moves to the wrong list loudly instead of silently.

`DATABASE_URL` sits in neither list: it is the one value that is transformed rather than
passed, and it should be its own named case in `collectEnv` so the transformation cannot be
lost by an allowlist edit.

## FINDING-3 — `scrubValue` mangles two diagnostic values, and one of them is a number

Probed the real `PATTERNS` over values the bundle will actually carry:

| value | after scrub |
|---|---|
| `postgresql://db.internal:5432/approof?schema=public` | unchanged ✓ |
| `/app/server/storage` | unchanged ✓ |
| `10.0.0.0/8,192.168.1.44` | unchanged ✓ |
| `20260902100000_add_metrics` | unchanged ✓ |
| `pgvector extension found at version 0.7.0` | unchanged ✓ |
| **`1234567890123`** (13-digit) | **`[redacted:thai_national_id]`** |
| `postgresql://approof:s3cr3tpw@db.internal:5432/approof` | `postgresql://approof:[redacted:email]:5432/approof` |

Two things follow.

**(a) Numbers must not be stringified before scrubbing.** `scrubValue` only touches
`typeof value === "string"`, so `uptime`, `totalmem`, and the `event_logs` counts are safe
**as numbers**. A collector that formats them (`String(os.totalmem())`, a timestamp in ms, a
byte count) hands a 13-digit string to the ID pattern and the bundle reports
`[redacted:thai_national_id]` for a memory figure. Worth one line in the plan: resource and
count values stay numeric through assembly; formatting is the reader's job.

**(b) The raw-`DATABASE_URL` row is the argument for order, not a safety net.** `scrubValue`
does redact it, but as an *email*, and it keeps the DB username. `stripUrlCredentials`
first, then `scrubValue`, is what the plan already says — this measurement is the reason to
keep that order rather than treating either as sufficient alone.

## FINDING-4 — `runChecks()` is not "already redacted by construction"

The recon's table says the doctor checklist needs no treatment. It carries interpolated free
text at 20+ sites (`utils/doctor/index.js:163-450`), including three the bundle should not
publish unexamined:

- `db.reachable` failure: `` `Cannot connect: ${error.message}` `` — a driver error message.
  Probed: a message quoting a role name shaped `apw-key-…` **is** caught by the credential
  pattern, so the reuse works — but only because `scrubValue` runs over it.
- `db.reachable` success: `` `Connected to ${maskUrl(databaseUrl)}` ``. The doctor's own
  `maskUrl` (`:466`) masks the **password only** and keeps the username. Probed:
  `postgresql://approof_admin:****@db.internal:5432/approof?schema=public`, unchanged by
  `scrubValue`. A DB username and internal hostname in a file destined for a public issue is
  exactly what §0 says the bar is about ("nothing the operator would be upset to find in a
  public issue"), and it is not a secret so no pattern will ever catch it.
- `env.writable` / `storage.writable`: absolute paths and uid numbers.

None of this is a reason to drop the checklist — it is the most useful section. It is a
reason to delete the phrase "already redacted by construction — no user text in it" from the
recon table, and to run `runChecks()` output through `scrubValue` like everything else.
For the `maskUrl` username specifically I'd ask PMO for a ruling rather than assume: either
`collectDatabase` re-derives the connection line from `stripUrlCredentials` (which drops
userinfo entirely), or the bundle accepts the username and says so in the issue. Silently
inheriting the doctor's weaker masking is the option to rule out.

## On the seed-secret whole-string test — endorsed, with one addition

The shape is right and it is the same shape `envDumpGuardHttp.test.js` uses: a field added
later without redaction fails an existing test rather than needing a new one.

The seed list in the recon (password-bearing `DATABASE_URL`, a non-allowlisted env key, an
`apw-key-…`, an email, a Thai national ID) covers the classes. One addition, from
FINDING-4: **seed a secret into a place the collector does not own** — set `DATABASE_URL` to
a password-bearing value and let the *doctor's* `db.reachable` detail carry it into the
bundle, rather than seeding only `process.env` and asserting `collectEnv`. That is the path
that actually failed in the probe above, and a test that seeds only the sources
`collectEnv` reads proves the mapping but not the path.

Also worth asserting explicitly: the scan runs over `JSON.stringify(bundle)` **after** the
final `scrubValue`, and the seeded values are chosen so that a *partial* match fails too — a
16-char credential seeded whole will not catch a bundle that emits its first 8 characters.

## Not raised

The `--bundle`-emits-JSON-only ruling and the stderr split are already pinned by ruling 2,
and the plan's "parse the entire stdout" (not "contains a `{`") is the correct assertion. The
`doctor.test.js` header note (task 4) is documentation and needs no review from me.
