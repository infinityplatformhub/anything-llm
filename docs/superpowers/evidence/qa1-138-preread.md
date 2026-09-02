# QA-1 — #138 S4b slice 3 pre-read (before code)
Written by PMO from QA-1's body. Read: PostgresJobQueue.claim:87-114, heartbeat:178-184, complete:116-125, CoreJobWorker.run:31-51, PostgresJobScheduler.materialize:61-80, contract-s4b-slice3.md.

RF-1 overlap oracle: claim's window is a DB window; Promise.all of two claims proves nothing. Need an injectable seam in claim (e.g. afterCandidates hook, like the existing `now` seam) so both transactions latch inside; assert `reached === 2`, exactly one wins, and assert on the LOSER (no checkpoint row for its workerId, provider checkpoint count 1). Second witness: `jobs.attempts === 1` (claim:106 increments only on the winning conditional update); 2 = both won. Wrong-reason fixtures: sequential claims + sleep (refused by lease not race); final-state only (applier is idempotent so always passes); same workerId (complete:120 masks); asserting totals not which lost.

RF-2 takeover witness: worker 1 must be ALIVE, not killed — pause mid-apply with a latch, suppress heartbeat, advance past leaseUntil, worker 2 claims (count===1), release worker 1. Three assertions: worker 1's next heartbeat/complete throws LeaseLostError (coexistence proof); final group_members = full target; policy_versions count = N changes not N+already-done (idempotency is what made it safe; membershipsAdded counts calls so is NOT a witness). "Lease never expires" mutant must red RF-2 only, not RF-1.

RF-4 per-provider: lark + ldap jobs, same runAt, one claim({types}) call, latch both inside, reached===2, both complete. Paired mutants: provider-independent type → RF-4 red/RF-1 green; global advisory lock → RF-4 red/RF-1 green; unconditional update → RF-1 red/RF-4 green. Same-set reds = fixtures not separating.

RF-3: assert the leaseUntil VALUE (derived number, not 30000), not existence. RF-7/R2a: unbounded Lark fetch is what makes RF-2's hazard reachable — same failure two layers. First finding at SHA time if no barrier seam exists in claim.
