-- T-7 (#31): a record of grants that no longer exist.
--
-- `revokeGrant` DELETEs the grant row, so a `revoked_by` column on
-- principal_role_grants would be destroyed by the very act it is meant to
-- record. The audit question is precisely "what used to be here, and who took
-- it away" — that has to outlive the row.
--
-- Soft-deleting the grant instead was rejected: every query that reads grants
-- would then have to remember `WHERE revoked_at IS NULL` forever, and one
-- omission silently restores revoked access.

CREATE TABLE "grant_revocations" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL DEFAULT 1,
    -- What was taken away. Denormalised on purpose: the grant row is gone, so
    -- these cannot be foreign keys to it, and the roles table may later be
    -- edited — the name at revocation time is what the auditor needs.
    "principal_type" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "role_id" INTEGER,
    "role_name" TEXT NOT NULL,
    "workspace_id" INTEGER,
    -- Who took it. NULL only for service principals (seeds, migrations, jobs),
    -- which is why revoked_by_type is NOT NULL and carries the real answer.
    "revoked_by_type" TEXT NOT NULL,
    "revoked_by_id" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policy_version" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT,

    CONSTRAINT "grant_revocations_pkey" PRIMARY KEY ("id")
);

-- "why can this person no longer do X" — the question this table exists for.
CREATE INDEX "grant_revocations_principal_type_principal_id_revoked_at_idx"
    ON "grant_revocations"("principal_type", "principal_id", "revoked_at");
CREATE INDEX "grant_revocations_workspace_id_revoked_at_idx"
    ON "grant_revocations"("workspace_id", "revoked_at");

-- Deliberately no FK to roles: a role deleted later must not erase the history
-- of grants that once carried it. role_name preserves the answer.
