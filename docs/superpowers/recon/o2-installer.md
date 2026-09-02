# Recon — O2 Installer / setup wizard

Owner: Dev 5. Base `origin/approof/main` @ `fb848620`. Read-only recon; no code.

Backlog (program-backlog.md:66): *O2 | Installer/setup wizard | P0-2 | 3 cw | ติดตั้งเครื่องเปล่า → ใช้งานได้ ภายใน 1 ชม. โดยไม่แตะ .env มือ*

## 0. The headline

A blank machine cannot reach a running instance today, and the blocker is not the wizard — it is that **the server refuses to boot without a secret nobody generates**.

`API_KEY_PEPPER` throws at import time when it is shorter than 32 bytes (`server/utils/apiKeySecurity/index.js:9`). Nothing in `docker/docker-entrypoint.sh` creates it, and `docker/.env.example` mentions it nowhere. So the documented path — copy `.env.example`, `docker compose up` — produces a container that dies on startup until the operator hand-edits a file. That is the DoD failing at the first step, before any wizard is reached.

The wizard itself is the smaller half of this issue: `frontend/src/pages/OnboardingFlow/` already exists with Home, LLMPreference, UserSetup, DataHandling and Survey steps. O2 extends it; it does not build it.

## 1. What exists

| Piece | State |
|---|---|
| `docker/docker-compose.yml` | postgres:16 + app, `DATABASE_URL` composed from `POSTGRES_*`, healthcheck, named volume |
| `docker/docker-entrypoint.sh` | waits for PG → `prisma generate` → `migrate deploy` → boot. **Generates nothing.** |
| `docker/.env.example` | 604 lines |
| `server/.env.example` | 615 lines |
| `frontend/src/pages/OnboardingFlow/` | 5 steps, already shipped |
| `server/utils/boot/markOnboarded.js` | infers "onboarded" from `LLM_PROVIDER` / `VECTOR_DB` / `AUTH_TOKEN\|JWT_SECRET` |
| `writeEnvFileAtomic` (`updateENV.js:2095-2112`) | P0-4D(a): exclusive open at `0600`, `fsync`, `rename`; refuses symlinks and foreign-owned files |

## 2. The five secrets, and a wrinkle worth knowing before writing code

`INSTANCE_AUTH_KEYS` (`updateENV.js:1834-1840`) already names exactly the set O2 must generate: `AUTH_TOKEN`, `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`.

But `dumpENV`'s `protectedKeys` allowlist does not treat them alike — measured, not assumed:

| Key | In `protectedKeys`? |
|---|---|
| `SIG_KEY` | yes — `dumpENV` writes it |
| `SIG_SALT` | yes — `dumpENV` writes it |
| `AUTH_TOKEN` | **no** |
| `JWT_SECRET` | **no** |
| `API_KEY_PEPPER` | **no** |

So `dumpENV` cannot be the mechanism for all five: three of them would be silently dropped. That is not a defect to fix here — `AUTH_TOKEN` and `JWT_SECRET` are excluded on purpose (they are `secret: true` in `KEY_MAPPING`, and #48 moved credential-valued settings into the encrypted store rather than back onto disk). It means **generation must write the file directly through `writeEnvFileAtomic`, not through `dumpENV`**, and the plan must say so or it will produce an installer that appears to work and persists two keys out of five.

PMO ruling Q2 sends these to the mounted `.env` rather than CredentialStore, and the reason holds up in the code: `SIG_KEY`/`SIG_SALT` are the store's own encryption inputs (`updateENV.js:1830-1831` says so outright), so a store that needs them cannot also hold them.

**Only when absent.** An operator who set a value must never have it replaced — a regenerated `API_KEY_PEPPER` invalidates every existing API key, and a regenerated `SIG_KEY` makes the credential store unreadable.

## 3. Locale — the risk is narrower than it looked

V9 (#61) found that `pg_trgm` produces zero trigrams for Thai on a `LC_CTYPE=C` database, so Thai chat search silently loses its index. The obvious conclusion was that O2 must force the locale. Measured instead:

```
postgres:16         template1 | en_US.utf8
postgres:16-alpine  template1 | en_US.utf8
```

Both images set `LANG=en_US.utf8`, so `initdb` already produces a UTF-8 cluster. **The compose happy path is not affected.** `POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8"` is still worth adding (PMO ruling Q4) as one line of belt-and-braces against a future base-image change — but as insurance, not as the fix.

The real exposure is the operator who points `DATABASE_URL` at an existing corporate PostgreSQL, which may well be `C`. That is a **verify** problem, not a **set** problem: the collation of a database is fixed at creation and O2 cannot change it. #61 already logs the finding at every boot (`utils/chatSearch/localeSupport.js`); O2's job is to surface it during setup, while the operator is still choosing a database.

Per ruling Q4: warn loudly, never block. English search is unaffected, and refusing to boot would lock out every customer who does not use Thai.

## 4. Scope

**In (ruling Q1):** docker compose is the happy path that must fit in an hour. External PostgreSQL gets a preflight that reports what fails and how to fix it, with no time guarantee. Bare metal is out.

1. **Secret generation** — the five keys above, `crypto.randomBytes`, written through `writeEnvFileAtomic`, only when absent, with a printed notice that these five must be backed up (ruling Q3; rotation and backup are O3).
2. **Preflight / doctor** — PostgreSQL reachable; `datctype` UTF-8; `CREATE EXTENSION` permitted for `vector` and `pg_trgm`; port free; storage writable. Reported as a list an operator can act on, not a stack trace.
3. **Wizard** — new steps on the existing `OnboardingFlow`: deployment/database mode, secrets (generated, shown once), preflight results.
4. **`.env.required.example`** — roughly fifteen keys that actually matter, alongside the existing 604-line file rather than replacing it.

**Out:** offline/air-gap bundles (O1); rotation and backup (O3); bare-metal install. Ruling Q5 constrains rather than adds: setup must make **no network calls**, so an air-gapped install is not blocked by O2 even though O2 does not package for it.

## 5. Open questions for the plan

- Where does generation run? The entrypoint (before Node boots, so `API_KEY_PEPPER` exists by import time) or a `prestart` script? The pepper throws at *import*, so anything running inside the server process is already too late.
- Does the preflight run as a container command an operator can invoke on demand (`docker compose run --rm app doctor`), or only during boot? A doctor that only runs at boot cannot be used to diagnose a failed boot.
- `markOnboarded` infers onboarding from `AUTH_TOKEN`/`JWT_SECRET` being set. Generating those unconditionally would mark a fresh install as already onboarded and skip the wizard entirely. This needs settling before step 1 is written.

## 6. Mockup

Required (infi-dev step 1.5 — this has UI). Two directions, both clickable, both showing the preflight page in four states (idle / checking / pass / fail-with-remedy):

- **A — full-page wizard**: one decision per screen, back/next, progress rail.
- **B — single-page checklist**: every requirement listed at once, each row resolving in place.

Committed to `docs/superpowers/mockups/` and pinned by SHA in the evidence contract before `task.sh start`.

## PMO rulings (2026-09-02)

Ruling: (Q1) compose = happy path <1 hr; external PG = preflight/doctor reporting failures with remedies, no time guarantee; bare-metal out of O2.

Ruling: (Q2) generated secrets go to the mounted `.env`, never CredentialStore — chicken-and-egg, since `SIG_KEY` is the store's own key. Atomic, `0600`, and only when the key is absent; never overwrite an operator's value.

Ruling: (Q3) rotation and backup are O3. O2 prints a clear notice at generation naming the five keys that must be backed up, plus a residual entry.

Ruling: (Q4) warn hard, never block, matching #61's boot report. Compose adds `POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8"` as belt-and-braces.

Ruling: (Q5) O2 must not *obstruct* air-gap — no network calls during setup — but offline bundling stays in O1.

Ruling: `.env.example` is not replaced; a new `.env.required.example` (~15 keys) sits beside it.

Ruling: mockup is two directions (full-page wizard vs single-page checklist), preflight page clickable in four states, committed under `docs/superpowers/mockups/` and SHA-pinned before `task.sh start`.
