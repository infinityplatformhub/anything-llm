# QA-2 — #135 / #136 slice 2 oracle staged on main 0d5306d3d (written by PMO from QA-2's body)
Runner /tmp/qa2-135-rerun.sh <sha>, probe /tmp/qa2-probe135.js. Baseline PASS 7 / FAIL 3 / SKIP 3.
P0 (measured, main): delete a content_moderator (holds access.diagnose + document.read) with no cleanup, setval users seq, successor lands on the victim's EXACT id and inherits doc=true role=true. Stays as the witness that P1's mechanism is live.
P4 rollback `User.delete({})`: leaves 3 user-principal role grants + 3 document_acl rows, policy_versions bump 0 (17→17); RF-4 asserts exactly one bump.
P1/P2/P3 SKIP "offboardUser not implemented" (absent from policyRepository at this SHA).
Two probe bugs caught by controls: `member` holds only chat.send + org.member (assertions would have passed for free) → content_moderator + fixture guard reading role_permissions; setval(id-1) crashes at id 1 → setval(id,false).
Open (TL-2): which principal each call site passes to revokeGrant; exempt principal on admin paths removes the escalation check.

## Second rehearsal (03:55) — plausible-wrong stubs
inert → 8 red · raw deleteMany + bump (looks right, no revocation rows) → 1 red: P3 per-grant half ONLY · per-grant with bogus role ids → 1 red: P3 identity ONLY (new: revoked role_id set == roles held; revoked_by_id non-empty). P3 now 7 assertions. P4 ×3 stay red until #135 (rollback path is #135's lane) — reported as out-of-scope on the slice-2 SHA.

## P6 + correct-fix signature (10:30)
P4/P5 drive User.delete at the MODEL layer; a contract-shaped #135 (route calls offboardUser, User.delete untouched) leaves them RED BY DESIGN — P5 is a DISCRIMINATOR of where cleanup landed. New P6 drives DELETE /admin/user/:id with a real super_admin token: grants 0, acl 0, revocations 1 → GREEN under a contract-shaped stub; RED (1/1/0) on 02778b133. Correct-fix signature = P6 green + P5 red. Probe 35 assertions; baseline 27/8. Site 2 (API-key route) route case to be added; site 3 rollback has no HTTP fixture reaching the catch → P4 model-layer is the oracle, reported as such.
