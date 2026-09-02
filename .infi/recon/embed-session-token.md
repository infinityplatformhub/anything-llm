# Recon: embed session token — unguessable, signed (split from T-4b W-10 per PMO ruling)
- Today: embed sessionId is a client-chosen UUID; T-4b (#29) adds session→owner binding + assertAuthorized only. Any party who learns a valid UUID from an allowed origin still bears it (S-24 shape).
- Work: on session open, server mints token = HMAC(SIG_KEY, embedUuid|sessionUuid|issuedAt) delivered as httpOnly cookie (SameSite per embed origin allowlist) or bearer header for non-cookie embeds; embedHistoryAccess verifies HMAC + expiry before binding check. Rotation on embed key regen.
- Owner files: server/utils/middleware/embedMiddleware.js, server/endpoints/embed/*.js, frontend embed widget handshake (frontend/src/... embed) — coordinate with T-4b merge first.
- Deps: #29 merged (binding), SIG_KEY (exists). No migration.
- RED DoD: HTTP test — forged/valid-format UUID without token → 401; token for session A used on session B → 403; expired → 401; positive control widget flow end-to-end. Header vs cookie both covered.
- Collision: embedMiddleware.js owned by T-4b until #29 merges. After.
