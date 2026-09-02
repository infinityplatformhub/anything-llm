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

## QA-1 BLOCKER-1 (mint oracle)

Ruling: QA-1 is right and the finding is mine — `endpoints/embed/index.js` minted for whatever `sessionId` the body named, so the gate was a formality: POST stream-chat with a victim's UUID returned a valid token, and that token opened their history even with the flag ON — risk if wrong: none, verified RED through the real route stack before fixing (end-to-end case returned 200).

Ruling: Minting is now conditional (`mintIfEntitled`) with exactly two entitlements — the session is NEW (no `embed_chats` row for this embed+session, so no conversation exists to steal), or the caller already presents a valid token for it (rotation, which every message after the first needs) — risk if wrong is a visitor whose first message failed to persist gets a token on the retry, which is the same entitlement they already had.

Ruling: Existence is scoped to `(embed_id, session_id)`, not `session_id` alone — a session id belonging to a DIFFERENT embed must not count as existing here, or embed B's traffic could block minting for embed A — risk if wrong is the cross-tenant direction, already closed by W-10 on the read side.

Ruling: An unentitled request gets NO token but the chat still proceeds (no 4xx) — refusing to answer would make the route a "does this session exist" oracle of exactly the shape being closed — risk if wrong is an attacker learns nothing from the response body, only from a header's absence, which is the same bit the 4xx would have leaked more loudly.

Ruling: The minting rule applies in BOTH flag states — `EMBED_REQUIRE_SESSION_TOKEN` governs only the demand on the history routes. If minting stayed loose while the flag was off, a deployment mid-rollout would be handing out tokens that become valid the instant the flag flips — risk if wrong is none; asserted in both states.

Ruling: `embedHistoryRateLimit` added to stream-chat (QA-1 item 3) — the per-embed quotas in `canRespond` cap chat volume, not probe rate, and `mintIfEntitled` now answers a question about session existence via the header's presence — risk if wrong is a legitimate high-traffic embed shares the 120/min IP budget the history routes already use.

Ruling: `Access-Control-Expose-Headers` appends rather than assigns (QA-1 NIT-2) — overwriting would silently stop any other header a deployment exposes from reaching the browser — risk if wrong is a duplicate entry in the list, which is harmless.

Ruling: NIT-1 (presence-based flag: `EMBED_REQUIRE_SESSION_TOKEN="false"` reads as ON) recorded here as residual, not fixed — it matches `EMBED_REQUIRE_ALLOWLIST` five lines above it and PMO ruled no change — risk if wrong is an operator writing "false" gets enforcement they did not intend; the .env.example comment says "when set".

Residual: NIT-1 above. Also unchanged — the widget half still lives in `anythingllm-embed` (tracked as #49), so the flag stays off until that lands.
