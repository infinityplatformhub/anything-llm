-- Forced rotation: existing plaintext bearer credentials are intentionally destroyed.
DELETE FROM "api_keys";
DELETE FROM "browser_extension_api_keys";

ALTER TABLE "api_keys"
  DROP COLUMN "secret",
  ADD COLUMN "secretDigest" BYTEA NOT NULL,
  ADD COLUMN "keyPrefix" TEXT NOT NULL,
  ADD COLUMN "scopes" TEXT NOT NULL DEFAULT '["*"]',
  ADD COLUMN "workspaceId" INTEGER,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastUsedAt" TIMESTAMPTZ(3),
  ADD COLUMN "revokedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "api_keys_secretDigest_key" ON "api_keys"("secretDigest");
CREATE INDEX "api_keys_keyPrefix_idx" ON "api_keys"("keyPrefix");
CREATE INDEX "api_keys_workspaceId_idx" ON "api_keys"("workspaceId");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "browser_extension_api_keys"
  DROP COLUMN "key",
  ADD COLUMN "secretDigest" BYTEA NOT NULL,
  ADD COLUMN "keyPrefix" TEXT NOT NULL,
  ADD COLUMN "scopes" TEXT NOT NULL DEFAULT '["*"]',
  ADD COLUMN "workspaceId" INTEGER,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastUsedAt" TIMESTAMPTZ(3),
  ADD COLUMN "revokedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "browser_extension_api_keys_secretDigest_key" ON "browser_extension_api_keys"("secretDigest");
CREATE INDEX "browser_extension_api_keys_keyPrefix_idx" ON "browser_extension_api_keys"("keyPrefix");
CREATE INDEX "browser_extension_api_keys_workspaceId_idx" ON "browser_extension_api_keys"("workspaceId");
ALTER TABLE "browser_extension_api_keys" ADD CONSTRAINT "browser_extension_api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
