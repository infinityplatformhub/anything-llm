# QA-3 evidence — #74 `ffb39ccf` — PASS

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-74b`, own `yarn install` +
`prisma generate`, own databases `qa3_74b` and `qa3_74n` (both `en_US.UTF-8`),
and a role `qa3_lp2` holding `CONNECT` + `USAGE` and nothing else, so
`CREATE EXTENSION` genuinely fails rather than being simulated.

Supersedes the `3165b913a` verdict. Everything in `qa3-74-3165b913a.md` still
holds — this SHA changes only which extensions the doctor demands.

## The conditional is correct in both directions

`requiredExtensions()`, driven directly:

| `VECTOR_DB` | needs |
|---|---|
| unset | `pg_trgm` |
| `""` | `pg_trgm` |
| `lancedb` / `LanceDB` / `chroma` | `pg_trgm` |
| `pgvector` / `PGVECTOR` / `PgVector` | `pg_trgm, vector` |
| `" pgvector "` (padded) | `pg_trgm` |

End to end, against real databases and the low-privilege role:

| id | scenario | result |
|---|---|---|
| V1 | `VECTOR_DB` unset, `vector` never created | `PASS`, exit 0, and the detail says **why** it was skipped |
| V3 | `VECTOR_DB=pgvector`, role cannot create `vector` | `FAIL ext.permitted — Cannot create: vector (42501)`, exit **1** |
| V5 | `VECTOR_DB=lancedb`, same role, same database | `PASS ext.permitted — already installed: pg_trgm`, exit **0** |
| V6 | `pg_trgm` not creatable, `VECTOR_DB=lancedb` | `FAIL`, exit **1** — the always-required half is not conditional |
| V7 | `pg_trgm` not creatable, `VECTOR_DB` unset | exit **1** |

V5 and V3 differ only by the environment variable, on the same database with the
same role — so the change in verdict comes from the configuration and not from
anything else.

The skip is stated, not silent:

```
[PASS] ext.available — The server ships every extension this configuration needs: pg_trgm.
       `vector` is not checked, because VECTOR_DB is not pgvector; set VECTOR_DB=pgvector
       and re-run if you intend to store vectors in PostgreSQL.
```

An operator who meant to use pgvector and mistyped the variable reads that line
and sees the mistake. A doctor that just said `PASS` would confirm the typo.

## Mutation

| mutant | result |
|---|---|
| `ALWAYS_REQUIRED_EXTENSIONS = []` — make `pg_trgm` conditional too | **4 failed** |
| drop `.toLowerCase()` | **1 failed** |
| `??` → `\|\|` | **survives, 87/87** |

The third mutant survives because it cannot fail: `??` and `||` differ only on
falsy-but-not-nullish inputs, and every one of them (`""`, `0`, `false`, `NaN`)
produces `false` from this comparison either way. Verified across all eight
inputs. So this is a survivor with no behaviour behind it — nothing to add a test
for. `??` remains the more precise thing to have written.

## One thing worth a ruling, not a fix here

The doctor accepts `PGVECTOR` and `PgVector` as pgvector. **The application does
not.** `getVectorDbClass` (`utils/helpers/index.js:88-124`) switches on the raw
string, so anything but exact lowercase `pgvector` falls through to `default:`,
logs `[ENV ERROR] No VECTOR_DB value found in environment! Falling back to
LanceDB`, and uses LanceDB.

Measured, same inputs, both sides:

| `VECTOR_DB` | doctor demands `vector` | app actually uses |
|---|---|---|
| `pgvector` | yes | pgvector |
| `PGVECTOR` | yes | **lancedb (fallback)** |
| `PgVector` | yes | **lancedb (fallback)** |
| `" pgvector "` | no | lancedb (fallback) |

So on `VECTOR_DB=PGVECTOR` the doctor blocks the boot over an extension the
instance would never have used. Being case-insensitive is the kinder behaviour
and it fails safe — it demands more, never less — but the two halves now disagree
about what the value means, and the doctor's leniency hides a misconfiguration
the app resolves by silently falling back to LanceDB. The padded case is the
same disagreement in the other direction: the doctor skips `vector`, and so does
the app, so nothing breaks, but the operator who typed `" pgvector "` gets
LanceDB without being told by either half.

The narrow question for a ruling: should the doctor match the app exactly (exact
lowercase, so a mismatch surfaces as "you are on LanceDB and did not mean to
be"), or should the app be taught to normalise the way the doctor does? The
second is a change to `getVectorDbClass`, which is outside #74.

Not a blocker: nothing here makes a correct configuration fail.

## Suites

`__tests__/scripts`: **87/87** (was 82 at `3165b913a`; five new cases cover the
conditional).
