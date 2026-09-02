-- S1 (#36): external identities bound to local users.
CREATE TABLE "identity_links" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id")
);

-- Two users claiming the same IdP identity must fail at the write, not at a
-- branch a caller can skip. Scoped to (provider, subject) because subjects are
-- only unique within an issuer.
CREATE UNIQUE INDEX "identity_links_provider_subject_key" ON "identity_links"("provider", "subject");

CREATE INDEX "identity_links_userId_idx" ON "identity_links"("userId");

ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
