-- S1 (#36): one in-flight login (state, nonce, PKCE verifier).
--
-- `state` is the primary key, so a replayed state collides on insert. Rows are
-- CONSUMED (consumedAt set), never deleted on use: a row that still exists is
-- how a replay is told apart from an expiry. The T-6 retention purge clears them.
CREATE TABLE "identity_login_state" (
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_login_state_pkey" PRIMARY KEY ("state")
);

-- The purge sweeps by expiry.
CREATE INDEX "identity_login_state_expiresAt_idx" ON "identity_login_state"("expiresAt");
