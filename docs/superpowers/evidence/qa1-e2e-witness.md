# QA-1 E2E witness — Phase 0 gate §1

Independent headed + headless run of the Playwright suite by QA-1 (not Dev3).
Worktree `.claude/worktrees/e2e`, suite `e2e/tests/phase0-gate.spec.js` (12 numbered
tests, 14 `test(` calls). Fill the Results section at run time; everything above it is
the reproduce procedure and is stable.

## Environment as found on this machine (2026-09-02)

| item | value |
|---|---|
| repo | `/Users/jintawattuitemwong/Documents/GitHub/anything-llm` |
| worktree | `.claude/worktrees/e2e` (HEAD `e91d511b` at time of writing — re-check before running) |
| node | `/opt/homebrew/opt/node@22/bin` — **must be first on PATH**; node 26 breaks `jsonwebtoken@9` via `buffer-equal-constant-time` |
| playwright | already installed at `e2e/node_modules/.bin/playwright`; chromium present in `~/Library/Caches/ms-playwright` |
| app port | `3111` (`E2E_APP_PORT`) — dev stack holds 3001 |
| mock LLM | `3112` (`E2E_MOCK_PORT`), container hostname `mock-llm:8080`, reached by the app as `http://mock-llm:8080/v1` |
| postgres | `55434` (`E2E_PG_PORT`) — dev machine holds 5432 |
| compose project | `aproof-e2e` (isolates from the dev stack) |
| API_KEY_PEPPER | set inside `e2e/e2e.env`, not the shell — the container reads it |

Containers already running from an earlier session at time of writing:
`aproof-e2e-postgres-1` (55434), `aproof-e2e-mock-llm-1` (3112), and a container
publishing 3111. `up.sh up` runs `down -v` first, so a stale stack is not a problem —
but it also **destroys the e2e volume and `e2e-storage`**, which is intended (onboarding
must run exactly once per run) and must never be pointed at the dev stack.

## Reproduce

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/jintawattuitemwong/Documents/GitHub/anything-llm/.claude/worktrees/e2e

# 1. bring the isolated stack up (down -v + build + wait on /api/ping, 120s cap)
./e2e/scripts/up.sh up

# 2. headed run — the witness run, 1 pass
cd e2e && yarn test:headed

# 3. reset to zero, headless run 1
cd .. && ./e2e/scripts/up.sh up
cd e2e && yarn test

# 4. reset to zero, headless run 2
cd .. && ./e2e/scripts/up.sh up
cd e2e && yarn test

# 5. tear down
cd .. && ./e2e/scripts/up.sh down
```

**PMO ruling (2026-09-02): `up.sh up` between every run.** All three runs start from a
destroyed volume, so onboarding runs three times, not once. The point is to prove
onboarding is repeatable — not just that the specs after it pass on an already-onboarded
instance.

Notes that matter when reading a failure:
- `workers: 1` and the tests are numbered `01`..`12`: **ordering is the fixture**. A
  failure in `01 onboarding` cascades; read the first failure only.
- `retries: 0` locally (`1` only when `CI` is set), so a flake shows as a real failure —
  which is what a witness run wants.
- `screenshot: "on"` and `trace: "retain-on-failure"` write into `e2e/artifacts/`;
  `e2e/report/` gets the HTML report (`yarn report` to open).
- `e2e.env` is deliberately missing `LLM_PROVIDER`/`AUTH_TOKEN` so the onboarding wizard
  actually runs; do not "fix" that by adding them.
- Every run is preceded by `up.sh up` (PMO ruling), so each of the three runs performs
  its own onboarding against a fresh volume. A failure in `01` on run 2 or 3 that did not
  appear on run 1 is an onboarding-repeatability defect, not a flake.

## What the 12 tests cover

01 onboarding wizard → app · 02 embedder switched to mock provider, instance multi-user ·
03 admin login on de-branded page · 04 create workspace · 05 upload + embed a .txt ·
06 chat answers with a citation to the upload · 07 admin creates a member via UI ·
08 admin creates an API key via UI · 09 audit log shows the flow's events ·
10 member blocked from admin UI and admin routes · 11 data survives container restart ·
12 logout returns to login

## Results — TO BE FILLED AT RUN TIME

| run | mode | SHA | passed/total | wall time | exit |
|---|---|---|---|---|---|
| 1 | headed | `e77d0b78` | 12/12 | 47.8s (48s incl. stack) | 0 |
| 2 | headless | `e77d0b78` | 12/12 | 43.5s | 0 |
| 3 | headless | `e77d0b78` | 12/12 | 43.3s | 0 |

Each run was preceded by `up.sh up` (`down -v` + rebuild + fresh volume), so onboarding
ran three separate times. `app ready after` 4s / 3s / 3s.

Failures: **none in any run.** All twelve tests passed in order every time:

01 onboarding wizard completes and lands in the app (13.0s) · 02 embedder switched to the
mock provider; instance is multi-user · 03 admin logs in on a de-branded login page
(617ms) · 04 create workspace (2.2s) · 05 upload a small .txt document and embed it into
the workspace · 06 chat answers with a citation pointing at the upload (3.0s) · 07 admin
creates a member user via admin UI (2.4s) · 08 admin creates an API key via admin UI
(2.1s) · 09 audit log shows the flow's events (2.1s) · 10 member cannot see admin UI or
hit admin routes (675ms) · 11 restart resilience: data survives container restart (6.2s) ·
12 logout returns to login (2.6s)

Two environment obstacles hit on this machine before the first run, neither a defect in
the suite — recorded so the next witness does not chase them:
- A previous `up.sh` was interrupted mid-build, leaving the compose network deleted while
  containers referenced it: `failed to set up container networking: network
  aproof-e2e_anything-llm not found`. `up.sh down` then `docker network prune -f` cleared it.
- The rebuild then failed with `node:22-slim: unable to lease content: lease does not
  exist`. A plain `docker pull node:22-slim` fixed it — a stale local image lease, not the
  Dockerfile.
- `npx playwright` picks up a global install and fails with "Test did not expect test() to
  be called here". Use `./node_modules/.bin/playwright` from `e2e/`, as the reproduce
  section does.

Screenshots/traces kept at: `e2e/artifacts/`, report at `e2e/report/`.

Witness statement: run by QA-1 session `anything-llm` (QA-1), read-only on the repo —
no file in the worktree was modified; the only writes are Playwright's own
`artifacts/`/`report/` output and the docker volumes that `up.sh` owns.
