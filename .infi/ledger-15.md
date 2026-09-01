# Ledger — issue #15 · Phase 0 E2E gate (Playwright on real docker stack)

Branch: `approof/e2e-playwright` (rebased onto approof/main @ 7a50f499)
Worktree: `.claude/worktrees/e2e` · Date: 2026-09-02 · Owner: Dev 3/4

## Stack design

- `e2e/scripts/up.sh [up|down|restart-app]` — own compose project
  (`aproof-e2e`), 127.0.0.1-only ports: app **3111**, mock-llm **3112**,
  postgres **55434** (base compose publishes 5432 which the dev machine holds;
  overridden). `down -v` + storage wipe before every `up` (onboarding runs
  exactly once per run). Readiness = poll `/api/ping` (first boot ~25-30s), no
  fixed sleeps. Port choice is env-overridable (E2E_APP_PORT/E2E_PG_PORT).
- `e2e/docker-compose.e2e.yml` — app + `mock-llm` service: tiny node container
  (canned SSE chat completions + deterministic hash embeddings via
  generic-OpenAI-compatible endpoints). No real keys, exercises the streaming
  path. App reaches it as `http://mock-llm:8080/v1`.
- `e2e/e2e.env` — DELIBERATELY unconfigured (see Ruling 1).

## Rulings

1. **markOnboarded forces the wizard through the UI.** The boot patch
   (`server/utils/boot/markOnboarded.js`) treats ANY of LLM_PROVIDER /
   VECTOR_DB / AUTH_TOKEN / JWT_SECRET env as "legacy instance already
   onboarded" and marks onboarding complete at boot — the wizard becomes
   unreachable and `/` lands straight in the app. Pre-configuring providers
   via env and testing the onboarding wizard are mutually exclusive. Chose the
   wizard: the test configures Generic OpenAI (LLM + embedder) against
   mock-llm through the actual onboarding steps.
2. **Multi-user admin comes from the wizard** ("My team" path), not from a
   direct API call — the earlier API shortcut existed only while env-preconfig
   made the wizard unreachable. Test 02 now just asserts the resulting
   multi-user state.
3. **Session reality:** the SPA keeps its JWT in localStorage
   (`approofworkspace_authToken`), not cookies — `page.request` calls need the
   bearer header injected (`authedFetch`). Each Playwright test gets a fresh
   context, so every authed test logs in via the helper; first logins dismiss
   the Recovery Codes modal (Download → Close).
4. **Port collisions are load-bearing on this machine**: 3001 (dev stack),
   3101 (someone's Next dev server), 5432/55433 (local pg + docker residue).
   up.sh defaults avoid all of them; PMO operational rule honored.
5. **Mock LLM asserts**: never answer content — only non-empty reply + citation
   naming the uploaded .txt. Upload is a small .txt, not PDF.

## Test flow (phase0-gate.spec.js, workers=1, ordered)

01 onboarding wizard (incl. de-brand text + network checks) → 02 multi-user
state → 03 admin login (de-brand again) → 04 workspace create → 05 .txt
upload + embed wait → 06 chat + citation → 07 member user via admin UI →
08 API key via admin UI → 09 audit log → 10 member negative (no admin UI, no
admin route) → 11 restart resilience (restart-app → relogin → data intact) →
12 logout.

## Status

WIP — see git log on the branch; this ledger updates when the suite is green.
