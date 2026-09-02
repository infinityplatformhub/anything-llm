-- S11a (#80): an invite can carry the address it was mailed to, and an expiry.
--
-- Slot 093000. Both columns NULLABLE, and `expiresAt` has NO DEFAULT — those two
-- facts are the whole compatibility story:
--
--   * `email` null means "nobody mailed this; it is a copy-link invite", which is
--     every invite that exists today and every one an admin creates without
--     typing an address. That path is unchanged.
--
--   * `expiresAt` null means "never expires". A DEFAULT here would silently
--     retire every invite already in the table — including ones handed out
--     minutes before the deploy — and the operator would see invites failing
--     with no idea a migration did it. The seven-day default belongs in
--     `Invite.create`, applied only when an address is present, where it is
--     visible in code and testable.
--
-- The pairing rule ("an emailed invite must expire") is enforced in the model
-- rather than as a CHECK constraint: two routes create invites
-- (`endpoints/admin.js`, `endpoints/api/admin/index.js`) and both go through
-- `Invite.create`, so the model is the single place that sees every creation.
-- A CHECK would also be right, and could be added later; it is not a substitute
-- for the model rule, because the model is what supplies the value.
ALTER TABLE "invites"
    ADD COLUMN "email" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMPTZ(3);

COMMENT ON COLUMN "invites"."email" IS
    'Address this invite was mailed to, or NULL for a copy-link invite that was never emailed. NULL is the pre-S11 behaviour and stays supported.';

COMMENT ON COLUMN "invites"."expiresAt" IS
    'When this invite stops being redeemable, or NULL for never. Deliberately has no column DEFAULT: a default would retire every pre-existing invite at deploy time. The 7-day value is applied by Invite.create for emailed invites only.';

-- Redemption reads by code and then checks status and expiry. The unique index
-- on `code` already serves the lookup; nothing here needs an index of its own,
-- and an unused index costs every insert. An expiry-sweep job, if one is added
-- for admin display, would want `("status", "expiresAt")` — added then, with the
-- query that justifies it.
