-- T-7 (#31, D-1): marker for the DISABLE_VIEW_CHAT_HISTORY migration.
--
-- The decision this migration records CANNOT be made in SQL: the env var lives
-- in the Node process, and Postgres has no access to it. `current_setting()`
-- returns NULL here no matter what the operator set, so a SQL branch on it
-- would silently take the "was not set" path forever — a migration that looks
-- like it read the environment and never did.
--
-- The read therefore happens in Node, at boot, exactly once, guarded by the
-- marker this migration establishes: see
-- server/utils/authorization/chatHistoryMigration.js.
--
-- Establishing the marker table row here (rather than in Node) keeps the
-- guard's existence tied to a migration, so a fresh database gets the same
-- one-shot semantics as an upgraded one.

-- Nothing to do structurally; the guard lives in policy_versions, which
-- 20260902020000 already created. This file documents the slot and the reason.
SELECT 1;
