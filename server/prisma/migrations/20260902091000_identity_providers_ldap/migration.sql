-- S3 (#60): LDAP configuration columns on identity_providers.
--
-- Slot 091000 (090000 belongs to #50). One table holds every provider's
-- configuration, and the SAML columns are as irrelevant to a directory as these
-- are to a SAML IdP — so both sets are nullable and a provider fills in its half.
--
-- ALL NULLABLE OR DEFAULTED: the SAML provider already in production has to keep
-- working across this migration, which is why none of these is NOT NULL without
-- a default.
--
-- There is deliberately NO bind-password column. Unlike SAML's certificates,
-- which are public material, the service account's password is a real secret;
-- this table is read on every login and sits in every backup, so it belongs in
-- CredentialStore (AES-256-GCM, bound to its key name) instead.
ALTER TABLE "identity_providers"
    ADD COLUMN "ldapUrl" TEXT,
    ADD COLUMN "baseDn" TEXT,
    ADD COLUMN "bindDn" TEXT,
    -- The attribute map, defaulted to what an ordinary directory uses so an
    -- operator overrides only what is actually different in theirs.
    ADD COLUMN "usernameAttribute" TEXT NOT NULL DEFAULT 'uid',
    ADD COLUMN "emailAttribute" TEXT NOT NULL DEFAULT 'mail',
    ADD COLUMN "displayNameAttribute" TEXT NOT NULL DEFAULT 'cn';
