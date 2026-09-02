-- S2 (#43): the two tables SAML needs, in one slot.
--
-- identity_assertion_ids — assertion IDs already spent.
--
-- SAML has no PKCE and no nonce: the bearer assertion IS the credential, so a
-- captured response logs someone in for as long as it is valid. Single use is a
-- UNIQUE constraint rather than a lookup in the ACS route, because a lookup is
-- one code path away from being skipped and loses the race between two requests
-- presenting the same assertion at once.
CREATE TABLE "identity_assertion_ids" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "assertionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_assertion_ids_pkey" PRIMARY KEY ("id")
);

-- Scoped to the provider. Assertion IDs are unique only within an issuer, so a
-- provider-blind constraint would let one tenant's traffic lock out another's.
CREATE UNIQUE INDEX "identity_assertion_ids_provider_assertionId_key"
    ON "identity_assertion_ids"("provider", "assertionId");

-- The T-6 purge sweeps by expiry. Unswept, this table grows by one row per login
-- attempt forever, including the unauthenticated ones an attacker paces.
CREATE INDEX "identity_assertion_ids_expiresAt_idx"
    ON "identity_assertion_ids"("expiresAt");

-- identity_providers — one provider, one configuration.
--
-- Public material only: entity ID, endpoints, signing certificates. The SP's own
-- private key goes to the CredentialStore (AES-256-GCM). This table is read on
-- every login and sits in every backup, so a secret column here is a secret in
-- plaintext at rest.
CREATE TABLE "identity_providers" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "ssoUrl" TEXT NOT NULL,
    -- A list, because Entra publishes the next certificate before signing with
    -- it. One certificate column forces a flag-day cutover, and every login
    -- fails as a bad signature between the rotation and someone noticing.
    "certificates" TEXT[],
    -- Fail closed: configuration is saved field by field, and a provider live at
    -- the first save would accept logins against a half-written certificate list.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- Two rows for one provider means the certificate a signature is checked against
-- depends on row order.
CREATE UNIQUE INDEX "identity_providers_provider_key"
    ON "identity_providers"("provider");

-- NIT-1 backfill. `identity_links.email` was written before normalizeForCompare
-- applied NFC, so a row stored in decomposed form would never match the composed
-- address the same IdP now sends — the R1 email check would miss it and the
-- person would get a second account. One statement, in this slot rather than a
-- new one: the constraint and the data it depends on land together.
UPDATE "identity_links" SET "email" = normalize("email", NFC);
