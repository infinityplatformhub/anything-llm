# Techlead-2 review — #87 `e6908fd54` (one VECTOR_DB normaliser, compared the same way everywhere)

**Verdict: PASS.** The normaliser is genuinely single, all four comparison sites use it, the
removal of O2a's spelling gate is correct rather than convenient, and every one of the ten
mutations I ran is caught.

Independent worktree `/tmp/tl2-87` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/base91`, `prisma generate` run, Node v22.23.1, my own PostgreSQL 16
on `:55472`. Per §7.14 no full-directory run — only the two suites this change touches, plus
mutations. Worktree clean; all three mutated files restored from backups.

Baseline: **74 passed, 74 total**.

---

## Is it really one normaliser?

Yes. `normalizeVectorDbKey` is defined once in `utils/helpers/index.js` and used at all four
sites the change names:

| site | before | after |
|---|---|---|
| `getVectorDbClass` | `getExactly ?? process.env.VECTOR_DB ?? "lancedb"` | `normalizeVectorDbKey(...)` |
| `supportedVectorDB` (`updateENV.js`) | its own inline `supported` array + raw `includes` | shared `SUPPORTED_VECTOR_DBS` + normaliser |
| `resetAllVectorStores` | `vectorDbKey === "pgvector"` | `normalizeVectorDbKey(vectorDbKey) === "pgvector"` |
| `requiredExtensions` (doctor) | its own `meansPgvector` helper | shared normaliser |

The duplicate provider list in `updateENV.js` is gone, which mattered as much as the
comparison: two lists disagreeing about one field is how `.env` came to accept spellings the
settings UI rejected.

**I grepped for anything still comparing the value raw.** What remains is eight provider
`connect()` guards of the shape `if (process.env.VECTOR_DB !== "chroma") throw`. Those are
**correctly left alone**, and I checked the interaction rather than assuming:

```
VECTOR_DB=CHROMA    → getVectorDbClass resolves Chroma → connect() THROWS "Chroma::Invalid ENV settings"
VECTOR_DB=PGVECTOR  → resolves PGVector              → connect() OK
VECTOR_DB=LanceDB   → resolves LanceDb               → (no guard, default arm)
```

So a case-variant now reaches the right provider, and seven of the ten providers then refuse
it at connect time. That is a real inconsistency, but it is **strictly better than before**
(the value used to reach LanceDB silently) and it fails closed with a named error rather than
storing data in the wrong place. `pgvector` and `lancedb` have no such guard, so they work
fully. Worth a follow-up so the guards use the normaliser too — not a blocker, and out of the
scope this SHA claims.

## Removing O2a's `config.vector_db` gate — correct, and the test says why

The gate existed because `getVectorDbClass` switched on the raw string, so `VECTOR_DB=PGVECTOR`
silently resolved to LanceDB and only the installer could catch it. Once the resolver
normalises, that spelling **works** — and a preflight still failing it would block a
configuration the app itself honours.

The test states this in the terms that matter:

> *"The check that was right last week is wrong this week, and it is this issue's job to
> retire it."*

and asserts both halves: `requiredExtensions("PGVECTOR")` returns `["pg_trgm", "vector"]`, and
`CHECK_IDS` no longer contains `config.vector_db`. Retiring a check without asserting its
absence would let it come back by merge.

I verified the four O2a tests removed alongside it were the ones that drove that check
specifically, and that the doctor suite still passes on my stock PostgreSQL 16.

## The log dedupe

`warnedVectorDbKeys` is a `Set` keyed **by value**, not a single boolean — so two different
typos are two different warnings, and one typo on the chat hot path is one line rather than
one per request. The message changed too, and the old one was actively misleading:
`"No VECTOR_DB value found in environment!"` when the value was found and simply matched
nothing. An operator grepping for their own typo was told the variable was unset.

The new message names the value, lists what would have been accepted, and says where the
embeddings are going instead.

## Mutation results — 10 of 10 caught

| # | mutation | result |
|---|---|---|
| N1 | normaliser drops `.trim()` | **14 failed** |
| N2 | normaliser drops `.toLowerCase()` | **16 failed** |
| N3 | empty value returns `""` instead of the default | **3 failed** |
| N4 | unrecognised value mapped to the default (loses the operator's spelling) | **8 failed** |
| N5 | `getVectorDbClass` stops normalising (the original bug) | **12 failed** |
| N6 | `supportedVectorDB` stops normalising | **2 failed** |
| N7 | `resetAllVectorStores` stops normalising | **2 failed** |
| N8 | doctor's `requiredExtensions` stops normalising | **2 failed** |
| N9 | dedupe removed, logs on every call | **2 failed** |
| N10 | dedupe keyed by a single flag rather than by value | **2 failed** |

N4 is the one I would have most expected to survive: returning an unrecognised value unchanged
rather than mapping it to the default looks like a stylistic choice, and it is not — the caller
quotes what the operator actually wrote, which is what makes the error message usable. Eight
tests depend on it.

N7 deserves a note about *how* it is caught. There is no live pgvector store in this suite, so
the test asserts on the **source** — that the comparison is not a bare `===` against the raw
key, and that `normalizeVectorDbKey` appears. That is a weaker assertion than behaviour and the
test says so outright in its comment. I would normally push back on a source assertion, but the
alternative here is no coverage at all for a branch whose failure mode is specific and severe
(the right provider with the wrong reset strategy, leaving pgvector's embedding table in place
with a dimension that can no longer be changed). Stating the limit is the right call.

## Also correct

- `SUPPORTED_VECTOR_DBS` lists ten providers, matching the ten `case` arms in
  `getVectorDbClass` — I counted both.
- `__resetVectorDbWarning` is a declared test seam rather than the suite reaching into the Set.
- The JSDoc for `getVectorDbClass` gained `pgvector`, which it had been missing.
- `getExactly` still bypasses `process.env` but is normalised too, so a caller passing
  `"PGVector"` explicitly gets the same treatment as the environment.

## Reproduction

```
git worktree add --detach /tmp/tl2-87 e6908fd54
cp -al /tmp/base91/server/node_modules /tmp/tl2-87/server/node_modules
cd /tmp/tl2-87/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
env -u VECTOR_DB npx jest __tests__/utils/helpers/vectorDbSelection.test.js \
                          __tests__/scripts/doctor.test.js --runInBand
```

The provider-guard interaction was measured with three one-line `node -e` scripts calling
`getVectorDbClass()` and `connect()` under `VECTOR_DB=CHROMA`, `PGVECTOR` and `LanceDB`.
Mutations were applied to working copies of `utils/helpers/index.js`,
`utils/helpers/updateENV.js` and `utils/vectorStore/resetAllVectorStores.js`, each restored
immediately after its run.
