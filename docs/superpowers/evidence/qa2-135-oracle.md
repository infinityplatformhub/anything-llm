# QA-2 — #135 / #136 slice 2 oracle staged on main 0d5306d3d (written by PMO from QA-2's body)
Runner /tmp/qa2-135-rerun.sh <sha>, probe /tmp/qa2-probe135.js. Baseline PASS 7 / FAIL 3 / SKIP 3.
P0 (measured, main): delete a content_moderator (holds access.diagnose + document.read) with no cleanup, setval users seq, successor lands on the victim's EXACT id and inherits doc=true role=true. Stays as the witness that P1's mechanism is live.
P4 rollback `User.delete({})`: leaves 3 user-principal role grants + 3 document_acl rows, policy_versions bump 0 (17→17); RF-4 asserts exactly one bump.
P1/P2/P3 SKIP "offboardUser not implemented" (absent from policyRepository at this SHA).
Two probe bugs caught by controls: `member` holds only chat.send + org.member (assertions would have passed for free) → content_moderator + fixture guard reading role_permissions; setval(id-1) crashes at id 1 → setval(id,false).
Open (TL-2): which principal each call site passes to revokeGrant; exempt principal on admin paths removes the escalation check.
