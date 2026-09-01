-- P0-4D(c) part 2: encrypted storage for provider credentials.
--
-- Provider secrets live in the .env file today. PR-4D(a) made that file 0600 and
-- atomic, which stops another local account reading it, but it is still plaintext on
-- disk, still copied into every backup of the storage volume, and still rebuilt from an
-- allowlist on every settings save.
--
-- Values are encrypted with AES-256-GCM. The key is derived from SIG_KEY, which already
-- has to be stable for a deployment (EncryptionManager depends on it), so this adds no
-- new secret to manage -- but it deliberately does NOT reuse EncryptionManager itself,
-- which is aes-256-cbc and unauthenticated: without a tag, anyone who can write the
-- table can flip ciphertext bits and the plaintext changes undetected.
--
-- One row per env key. `iv` and `authTag` are per-row, never reused.

CREATE TABLE "credential_store" (
  "id"            SERIAL PRIMARY KEY,
  "envKey"        TEXT NOT NULL,
  "ciphertext"    BYTEA NOT NULL,
  "iv"            BYTEA NOT NULL,
  "authTag"       BYTEA NOT NULL,
  "keyVersion"    INTEGER NOT NULL DEFAULT 1,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "credential_store_envKey_key" ON "credential_store"("envKey");
