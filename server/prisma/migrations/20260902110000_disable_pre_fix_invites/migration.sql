-- #71: revoke every invite whose code was already written to the audit log.
--
-- Until this release, `invite_created` stored the invite CODE in `event_logs`
-- (`endpoints/admin.js`), and the code redeems an account through the public
-- `POST /invite/:code`. Invites do not expire, so every pending code issued
-- before this migration is a live credential sitting in an append-only log that
-- is built to be exported to a SIEM.
--
-- Redacting the log rows would not help: a code that has already been exported,
-- backed up, or read is out. The only action that actually revokes the
-- credential is invalidating the invite itself, which is what this does.
--
-- WHY NOT rewrite the audit rows. The audit log is append-only by design and
-- `deleteAuditEvents` is its single sanctioned mutation path
-- (`utils/events/AuditEventSubscriber.js`). Scrubbing history here would set a
-- precedent that audit rows may be edited by any migration that finds them
-- inconvenient — a worse property to lose than the benefit of tidying data that
-- is no longer secret anyway. Scrubbing old rows remains available as a
-- housekeeping task; it is not the security fix and must not be mistaken for one.
--
-- BLAST RADIUS: every invite in `pending` status at the moment this migration is
-- applied — not only those whose code demonstrably reached a log. There is no
-- way to tell the two apart after the fact, and the safe direction is to revoke
-- more than strictly necessary rather than leave one live.
--
-- COST, stated plainly: pending invites that were legitimately handed out and
-- not yet accepted stop working, and an admin has to reissue every one of them.
-- That is the correct trade — an invite is cheap to reissue and a silently-live
-- credential is not cheap to contain. `claimed` and already-`disabled` rows are
-- untouched, so no existing account loses access.
--
-- What this does NOT undo: codes already exported in an audit feed or backup are
-- out, permanently. Disabling the invite removes their USE, not their exposure.
UPDATE "invites"
   SET "status" = 'disabled',
       "lastUpdatedAt" = NOW()
 WHERE "status" = 'pending';
