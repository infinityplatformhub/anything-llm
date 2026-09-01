# Ledger — issue 7 (P0-4D(a): .env atomic write 0600 + secret-leak scan)

Ruling: branch renamed to approof/p0-4d-env-hygiene-a — the name in the brief already belonged to a stale worktree at b5146345 that carries unrelated P0-7 work; reusing it would have mixed two tasks in one branch. If wrong, the PR opens under a name nobody expects and has to be renamed.

Ruling: exported writeEnvFileAtomic as a named function rather than inlining the atomic write inside dumpENV — dumpENV needs a live production process env to produce content, so testing the file properties through it would mean faking 50 env keys. If wrong, the module surface grows by one function that only tests call.

Ruling: refuse-and-return-false on a foreign-owned .env instead of throwing — every dumpENV call site ignores the return value, and throwing would turn a settings save into a 500 after the settings were already applied to process.env. If wrong, a misconfigured deployment silently stops persisting env changes and only the console line says why.

Ruling: masked the secret values in the updateENV response body rather than dropping the keys — the response is the only place the caller learns which settings were accepted, and the frontend does read the shape. If wrong, an operator reading the response cannot tell a masked value from a literal ten-asterisk value they typed.

Ruling: secret detection is a name heuristic over the env key (KEY, TOKEN, SECRET, PASSWORD, PEPPER, SALT, CREDENTIAL, PWD), marked with a ponytail comment — a per-key secret flag on KEY_MAPPING would touch every one of the ~200 entries for no test-visible gain today. If wrong, a future provider credential whose env name avoids all eight words is echoed in full.

Ruling: chmod the existing file to 0600 before the rename, not only the temp file — the rename replaces the inode so the old mode does not survive, but the window before it does, and an existing world-readable .env is exactly the state this task exists to end. If wrong, one redundant chmod syscall per dump.

Ruling: accepted the first full-suite run's single suite-level failure as a flake after reproducing it green twice — t1-authz-migration.test.js failed in an afterAll teardown timeout, passes alone (14/14) with the change applied, and the second full run was 72/72. If wrong, a real teardown race is being carried forward under a flake label.

Ruling: rebased onto approof/main at bf457759 after check passed on the older base — main had moved eight commits ahead while this task ran, and the pre-rebase diff carried 858 deletions of other people's work. If wrong, the rebase silently dropped a change that the older base still had.

Ruling: treated the afterAll hook timeouts in engine.test.js and t1-authz-migration.test.js as a pre-existing flake, not a regression — both drop a Postgres database in an afterAll that inherits the default 5000 ms hook timeout while their beforeAll gets 300_000, both pass in isolation (29/29 together), and neither file nor anything they import appears in this diff. If wrong, a real teardown contention introduced by the extra HTTP suite is being carried forward as somebody else's problem.
