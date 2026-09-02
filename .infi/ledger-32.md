Ruling: (Carve-out) widget half → anythingllm-embed PR, tracked in residual [→ needs issue] — `embed/` is a git submodule pointing at a separate repository, so the client change that stores the minted token and returns it on the history routes cannot land in this repo — risk if wrong is the token is minted and never presented, so enforcement stays dark until that PR lands.

Ruling: Enforcement sits behind `EMBED_REQUIRE_SESSION_TOKEN`, default OFF (PMO ruling, (ข)) — a server that enforced by default would 401 every widget that had not upgraded yet, and server and widget ship on separate cadences — risk if wrong is a deployment that never sets the flag keeps the pre-#32 behaviour, i.e. this issue's guarantee is opt-in rather than automatic.

Ruling: Minting is UNCONDITIONAL, only the demand is flagged — this is what makes the rollout order safe: widget ships first and starts sending tokens (accepted in both states, asserted), operator flips the flag second — risk if wrong is a negligible always-on HMAC per stream-chat request.

Ruling: Flag read per-request via `"EMBED_REQUIRE_SESSION_TOKEN" in process.env`, not captured at module load — presence-based to match `EMBED_REQUIRE_ALLOWLIST` five lines above it rather than introduce a second truthiness convention in one file — risk if wrong is `EMBED_REQUIRE_SESSION_TOKEN="false"` reads as ON; same trap the sibling flag already has, so the file is at least consistent, and the .env.example comment says "when set".

Ruling: The flag governs ONLY the new token gate — W-10 ownership, origin allowlist, enabled check and sessionId format all still run with it off, asserted in the OFF describe — risk if wrong is a flag intended to defer one gate silently disables four.

Ruling: Verification placed after the cheap gates but before the ownership query — an unsigned caller must not be able to make the database work, and that query must not become an existence oracle — risk if wrong is a probe cost and a side channel; both asserted.

Ruling: 401 and 403 split by reason (`absent`/`malformed`/`expired` → 401, `mismatch` → 403) — a token pointed at the wrong session is a different condition from no token — risk if wrong is the pair distinguishes credential states, but neither answer varies on whether the session exists, which is the property that matters.

Ruling: Expiry checked AFTER the signature — telling an unsigned caller "expired" would confirm a guessed timestamp was once real — risk if wrong is one extra HMAC on an expired token.

Ruling: No cookie-parser dependency; the Cookie header is read with stdlib string handling for exactly the one name needed — PMO ruling — risk if wrong is no general cookie semantics (quoted values), which this single opaque base64url token never uses.

Residual: the widget half. Until an `anythingllm-embed` PR stores the `x-allm-session-token` response header and returns it, `EMBED_REQUIRE_SESSION_TOKEN` must stay unset in every deployment. Needs its own issue against that repo; I do not hold access to open it.
