# #49 embed server-minted session — recon (Dev4) + PMO rulings (2026-09-02)

Recon: no schema change (embed_chats.session_id plain string; token is stateless HMAC via SIG_KEY). Server files: endpoints/embed/index.js (new POST /embed/:embedId/session), utils/middleware/embedSessionToken.js (server-side mint), canRespond gate for stream-chat. Widget (submodule Mintplex-Labs/anythingllm-embed): useSessionId.js + chatService.js 3 call sites do not send `x-allm-session-token` — residual of #32.

- Ruling Q1: not a hard cutover; stream-chat reject sits behind a flag, default off.
- Ruling Q2: new flag `EMBED_REQUIRE_SESSION_TOKEN_CHAT`; existing `EMBED_REQUIRE_SESSION_TOKEN` keeps its meaning. Boot log when history requires token but chat does not.
- Ruling Q3: mint route passes enabled + origin allowlist + embedHistoryRateLimit; minted token reads only the session it minted; oracle test token A vs session B → 403; no re-mint/renew with a token. Stateless — no row written at mint.
- Ruling: widget change ships as a patch file under docs/superpowers/patches/ with apply notes; upstream PR is the user's call. `[→ #49 widget]`
- Order: #30 1a merge → 1b → #49.
