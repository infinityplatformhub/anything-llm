-- S3b (#68), FINDING-5: a provider row is ONE complete shape, or it does not exist.
--
-- Slot 092000, between the LDAP columns (091000) and the work that followed.
-- Applying out of wall-clock order is safe here: this touches only
-- `identity_providers`, which nothing after 091000 has altered.
--
-- The defect: an LDAP row satisfies SAML's NOT NULL columns by writing empty
-- strings, and a SAML row leaves the LDAP columns NULL. Nothing stopped a row
-- that was half of each, or a row that was neither — a provider configured to
-- authenticate against nothing, accepted by the database and discovered at
-- someone's first login.
--
-- WHY NO DISCRIMINATOR COLUMN: the obvious constraint branches on `provider`
-- ("saml → these columns, ldap → those"). `provider` cannot carry that meaning.
-- It is the UNIQUE registry key, free text chosen by whoever configures the
-- deployment, and the schema tests deliberately write random values into it
-- (`saml-<hex>`, `ldap-<hex>`). Matching `provider = 'saml'` rejects every one
-- of those; matching `provider LIKE 'saml%'` lets a row select its own
-- validation rules by its own name, which is the same class of error as reading
-- a signed document's Subject document-wide — the value that chooses the rule is
-- chosen by the party being checked.
--
-- So the constraint is derived from the SHAPE of the row and names neither
-- provider. The cost is that both shapes are pinned in SQL and the next provider
-- kind edits this constraint. That is deliberate: it is a visible edit in a
-- migration, not a silent gap.
ALTER TABLE "identity_providers"
    ADD CONSTRAINT "identity_providers_one_shape" CHECK (
        (
            -- SAML: its own columns filled in, and no directory configuration.
            "entityId" <> '' AND "ssoUrl" <> ''
            AND "ldapUrl" IS NULL AND "baseDn" IS NULL AND "bindDn" IS NULL
        ) OR (
            -- LDAP: a directory to reach, a place to search, an account to search
            -- as. `<> ''` as well as NOT NULL — an empty string is not a URL, and
            -- an ORM will write one happily.
            "ldapUrl" IS NOT NULL AND "ldapUrl" <> ''
            AND "baseDn" IS NOT NULL AND "baseDn" <> ''
            AND "bindDn" IS NOT NULL AND "bindDn" <> ''
            AND "entityId" = '' AND "ssoUrl" = ''
        )
    );

-- Deliberately NOT `NOT VALID`. A deployment holding a half-configured row fails
-- here, at migrate time — rather than carrying it forward to fail at someone's
-- login. `certificates` is deliberately absent from the constraint too: S2 made
-- it a list precisely so it can be empty while a certificate rotates, and
-- `enabled` defaulting to false is what keeps such a provider from
-- authenticating anyone meanwhile.

-- The empty string is now LOAD-BEARING, so it is written down where the next
-- person to touch these columns will be standing.
COMMENT ON COLUMN "identity_providers"."entityId" IS
    'SAML entity ID. NOT NULL, and an empty string means "this row is not a SAML provider" — the identity_providers_one_shape CHECK reads the empty string as absence. Making this column nullable inverts every clause of that constraint, so it may only be done in a migration that rewrites the constraint in the same step.';

COMMENT ON COLUMN "identity_providers"."ssoUrl" IS
    'SAML SSO endpoint. NOT NULL, and an empty string means "this row is not a SAML provider" — the identity_providers_one_shape CHECK reads the empty string as absence. Making this column nullable inverts every clause of that constraint, so it may only be done in a migration that rewrites the constraint in the same step.';
