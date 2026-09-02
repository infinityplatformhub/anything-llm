-- T-6 Phase B (#28): the audit retention window, as a system setting.
--
-- 90 days is the default and is written here rather than left to a code constant,
-- so an operator can see and change the value without a deploy, and so a fresh
-- install and an upgraded one agree on what the window is.
--
-- ON CONFLICT DO NOTHING: an instance that already set a window keeps it. This
-- migration establishes the default, it does not impose one.
--
-- The purge treats a missing, empty, zero, negative or unparseable value as "keep
-- forever" and deletes nothing. That is deliberate — a misread setting must never
-- be the thing that empties the audit log.

INSERT INTO "system_settings" ("label", "value", "createdAt", "lastUpdatedAt")
VALUES ('audit_retention_days', '90', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("label") DO NOTHING;
