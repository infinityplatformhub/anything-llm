-- Forced rotation for browser extension keys.
-- Irreversible by design: rollback loses all keys; they must be reissued.
DELETE FROM "browser_extension_api_keys";

ALTER TABLE "browser_extension_api_keys"
  DROP COLUMN "key",
  ADD COLUMN "secretDigest" BYTEA NOT NULL,
  ADD COLUMN "keyPrefix" TEXT NOT NULL;
CREATE UNIQUE INDEX "browser_extension_api_keys_secretDigest_key" ON "browser_extension_api_keys"("secretDigest");
CREATE INDEX "browser_extension_api_keys_keyPrefix_idx" ON "browser_extension_api_keys"("keyPrefix");
