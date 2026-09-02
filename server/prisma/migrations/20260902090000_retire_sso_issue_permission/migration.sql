-- #50: retire the `sso.issue` permission.
--
-- Ruling (A) deleted `GET /v1/users/:id/issue-auth-token`, the only route that
-- ever asked for this scope, together with the `/request-token/sso/simple`
-- route that was the only place its token could be redeemed. The permission now
-- names a capability nothing can exercise.
--
-- A NEW slot rather than an edit to 20260902020000 (which INSERTed the row) or
-- 20260902045000 (which names it inside a backfilled scope list). Applied
-- migrations are immutable: `_prisma_migrations` records them by checksum, so
-- editing one makes a fresh database and an upgraded one disagree about what
-- ran — the drift the slot discipline exists to prevent.

-- 1. Detach it from every role before deleting the row it points at.
--    The FK at 20260902020000:199 DOES cascade, so this DELETE is not required
--    for correctness. It is kept because it is explicit and idempotent: the
--    statement says what this migration removes rather than leaving it to a
--    constraint the reader has to go look up, and re-running it is a no-op.
DELETE FROM "role_permissions"
WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "action" = 'sso.issue');

-- 2. The permission itself.
DELETE FROM "permissions" WHERE "action" = 'sso.issue';

-- 3. Strip it from existing API keys.
--
--    20260902045000 wrote `sso.issue` into the scope list of every key it
--    backfilled. Those rows keep it. A stale scope is inert at authentication
--    time (`parseScopes` does not re-validate, only creation does), but a key
--    advertising a capability that no longer exists is a lie to whoever reads
--    it back, so it goes.
--
--    A key left holding NOTHING is NOT revoked. Whether a credential should
--    still exist is the operator's decision, not this migration's; it resolves,
--    authenticates, and is refused by every route, which is visible and
--    reversible. Revoking would be quieter and irreversible.
--
--    `- 'sso.issue'` on a jsonb array removes the element by value and is a
--    no-op when absent, so re-running changes nothing.
UPDATE "api_keys"
SET "scopes" = (("scopes"::jsonb) - 'sso.issue')::text
WHERE "scopes"::jsonb @> '["sso.issue"]'::jsonb;

-- 4. Name the keys this emptied, so an operator can find them without a query.
--    A NOTICE rather than a table: this is a fact about one upgrade, not state.
DO $$
DECLARE
  emptied_count INTEGER;
  emptied_prefixes TEXT;
BEGIN
  SELECT COUNT(*), COALESCE(STRING_AGG("keyPrefix", ', ' ORDER BY "keyPrefix"), '')
    INTO emptied_count, emptied_prefixes
    FROM "api_keys"
   WHERE "scopes"::jsonb = '[]'::jsonb;

  IF emptied_count > 0 THEN
    RAISE NOTICE '[#50] % API key(s) now hold no scopes and can call nothing: %. They were NOT revoked — delete or re-scope them deliberately.',
      emptied_count, emptied_prefixes;
  END IF;
END $$;

-- 5. The permission vocabulary changed, so the policy clock moves. A cached
--    decision made under the old vocabulary must not be trusted afterwards.
INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant', 'org:1');
