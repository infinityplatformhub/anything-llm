-- PR-4c: stop minting wildcard API keys, and retire the ones already minted.
--
-- PR-4b removed "*" from the routes. It survived in the keys: the column defaulted to
-- '["*"]' and the model fell back to the same value, so every key satisfied every
-- scope no matter how precisely the routes were named.
--
-- Existing '["*"]' rows are rewritten to an enumerated legacy set rather than left
-- alone or emptied. Left alone, the wildcard check would have to stay in the
-- middleware and nothing would actually change. Emptied, every deployed integration
-- breaks at the same instant. The rewrite keeps them working with exactly the access
-- they exercise today, but as a list an operator can read, audit and narrow -- and
-- api_key_legacy_wildcard_grants records which keys were rewritten so the boot report
-- can name them.

-- 1. No new key may inherit a scope list. The model now requires one explicitly; this
--    removes the fallback underneath it so neither layer can mint a silent grant.
ALTER TABLE "api_keys" ALTER COLUMN "scopes" DROP DEFAULT;

-- 2. Record which keys held the wildcard, before rewriting them. Written first so the
--    rewrite cannot leave the log incomplete if it fails partway.
CREATE TABLE IF NOT EXISTS "api_key_legacy_wildcard_grants" (
  "id"           SERIAL PRIMARY KEY,
  "api_key_id"   INTEGER NOT NULL,
  "keyPrefix"    TEXT    NOT NULL,
  "grantedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_legacy_wildcard_grants_api_key_id_key"
  ON "api_key_legacy_wildcard_grants"("api_key_id");

INSERT INTO "api_key_legacy_wildcard_grants" ("api_key_id", "keyPrefix")
SELECT "id", "keyPrefix" FROM "api_keys"
WHERE "scopes"::jsonb @> '["*"]'::jsonb
ON CONFLICT ("api_key_id") DO NOTHING;

-- 3. Rewrite the wildcard rows to the enumerated set. This list is every scope any
--    route asks for as of PR-4b part 4, minus system.env.read: a legacy key was never
--    granted the provider credentials deliberately, and inheriting them through a
--    migration is not a grant anyone made.
UPDATE "api_keys"
SET "scopes" = '["chat.read","chat.write","document.bulk_export","document.delete","document.folder.manage","document.pin","document.read","document.search","document.write","embed.chat.read","embed.create","embed.delete","embed.read","embed.write","embedding.compute","image.generate","invite.create","invite.delete","invite.read","sso.issue","system.read","system.write","thread.create","thread.delete","thread.write","user.read","user.write","workspace.create","workspace.delete","workspace.embeddings.manage","workspace.members.manage","workspace.read","workspace.write"]'
WHERE "scopes"::jsonb @> '["*"]'::jsonb;
